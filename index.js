const fs = require('fs/promises')
const {addDays} = require("date-fns");
const {sendNotification} = require("./modules/ringCentral");
const {db} = require("./modules/db");
const {PromisePool} = require("@supercharge/promise-pool");
const {formatter} = require("./modules/utils/numberFormatter");


async function getConfig() {
    try {
        return JSON.parse(await fs.readFile('./config.json', 'utf-8'))
    } catch (e) {
        console.error(e)
        throw new Error('Error reading config file')
    }
}
async function setConfig(config) {
    return await fs.writeFile('./config.json', JSON.stringify(config, null, 2))
}
async function getPickTransactions(startDate, endDate) {
    if (!startDate || !endDate) {
        throw new Error('Missing required fields')
    }
    if (!startDate instanceof Date || !endDate instanceof Date) {
        throw new Error('Invalid date format')
    }
    if (!startDate) {
        console.log("No Start Date Provided, defaulting to today")
        startDate = new Date()
    }
    if (!endDate) {
        console.log("No End Date Provided, defaulting to today")
        endDate = new Date()
    }
    console.log(`Querying Pick Transactions for: ${startDate.toString()} upto ${endDate.toString()}`)
    startDate = startDate.toISOString().split('T')[0]
    endDate = endDate.toISOString().split('T')[0]

    return await db.query(`
        SELECT transaction_date,
               sku,
               quantity,
               quantity_before,
               quantity_after
        FROM surtrics.surplus_metrics_data t
        WHERE transaction_type = 'Pick'
          AND sku LIKE '%-3'
          AND quantity_after = 0
          AND transaction_date >= $1
          AND transaction_date < $2
    `, [startDate, endDate])
        .then(res => res.rows)
        .catch(err => {
            console.error(err)
            throw new Error('Error querying the database')
        })
}
async function getUsedComponentQuantity(sku) {
    if (!sku) {
        throw new Error('Missing required fields')
    }
    if (!sku.includes('-3')) {
        throw new Error('Invalid SKU format')
    }
    let baseQuery = `
        SELECT retail_price,
               quantity,
               sku
        FROM sursuite.components t
        WHERE sku = $1
    `
    const refurbComponent = await db.query(baseQuery, [sku]).then(res => res.rows[0])
    if (!refurbComponent) {
        throw new Error('Refurbished Component not found')
    }
    sku = sku.replace('-3', '-4')
    console.log(`Querying Used Component Quantity for SKU: ${sku}`)
    const usedComponent = await db.query(baseQuery, [sku]).then(res => res.rows[0])
        .catch(err => {
            console.error(err)
            throw new Error('Error querying the database')
        })

    return {
        ...usedComponent,
        refurbishedRetailPrice: refurbComponent['retail_price'],
        potentialRevenuePerItem: Number(refurbComponent['retail_price']) - Number(usedComponent['retail_price'])
    }
}
async function getUsedComponents(pickTransactions) {
    const {results} = await PromisePool
        .for(pickTransactions)
        .withConcurrency(10)
        .process(async (transaction) => getUsedComponentQuantity(transaction['sku']));
    return results
}
async function getItemsToRefurbFrom(usedComponents) {
    return usedComponents
        .filter(item => item['quantity'] > 0)
}
const generateSkuRestockMessage = (item) => {
    return `* Sku: [${item['sku']}](https://app.skuvault.com/products/product/list?term=${item['sku']})
    * Quantity In Stock: ${formatter(item['quantity'])}
    * Used Retail Price: ${formatter(item['retail_price'], 'currency')}
    * Refurbished Retail Price: ${formatter(item['refurbishedRetailPrice'], 'currency')}
    * Potential Revenue Per Item: ${formatter(item['potentialRevenuePerItem'], 'currency')}
`
}


(async () => {
    let config, startDate;
    const notificationData = {
        title: null,
        dateRange: null,
        status: null,
        description: null,
        facts: []
    }
    try{
        config = await getConfig()
        startDate = new Date(config['lastRun'])
        let queryStartDate = startDate
        const endDate = addDays(startDate,1)
        notificationData.title = `${config['baseMessage']}`
        notificationData.dateRange = `${startDate.toDateString()} to ${endDate.toDateString()}`
        const pickTransactions = await getPickTransactions(queryStartDate, endDate)
        config['lastRun'] = endDate.toString();
        await setConfig(config)
        if (pickTransactions.length === 0) {
            console.log('No Pick Transactions matching query found in the date range')
            notificationData.status = config['ErrorNoItems'];
            notificationData.description = `No Pick Transactions matching query found in the date range`
            return
        }
        notificationData.facts.push({
            key: 'Pick Transactions',
            value: pickTransactions.length
        })
        const usedComponents = await getUsedComponents(pickTransactions);
        if (usedComponents.length === 0) {
            notificationData.status = config['ErrorNoUsedItems'];
            notificationData.description = `No Used Components found`
            return
        }
        notificationData.facts.push({
            key: 'Used Condition Skus',
            value: usedComponents.length
        })
        const itemsForRestock = await getItemsToRefurbFrom(usedComponents);
        if (itemsForRestock.length === 0) {
            notificationData.status = config['ErrorNoItemsInStock'];
            notificationData.description = `No Items to restock from`
            return
        }
        notificationData.status = config['MessageFoundItems'];
        notificationData.description = `*The following items had all on hand quantity in refurbished condition picked, These items have Used inventory available to be refurbished.*`
        notificationData.facts.push(`${itemsForRestock.map(generateSkuRestockMessage).join('\n')}`)
        notificationData.facts.push({
            key: 'Items for Restock',
            value: itemsForRestock.length
        })
    }
    catch (e) {
        console.error(e)
    }
    finally {
        if (config['debug']) {
            console.log(notificationData)
        }else {
            await sendNotification(notificationData)
        }

    }
})()