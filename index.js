require("dotenv").config();
const {db} = require('./modules/db');
const {PromisePool} = require('@supercharge/promise-pool')
const {subDays, addHours, addDays, setHours, setMinutes, setSeconds, setMilliseconds} = require('date-fns')
const {sendRingCentralMessage} = require("./modules/ringCentral");
const {formatter} = require("./modules/utils/numberFormatter");
const fs = require('fs/promises')

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

const generateSkuRestockMessage = (item) => {
    return `* Sku: [${item['sku']}](https://app.skuvault.com/products/product/list?term=${item['sku']})
    * Quantity In Stock: ${formatter(item['quantity'])}
    * Used Retail Price: ${formatter(item['retail_price'], 'currency')}
    * Refurbished Retail Price: ${formatter(item['refurbishedRetailPrice'], 'currency')}
    * Potential Revenue Per Item: ${formatter(item['potentialRevenuePerItem'], 'currency')}
`
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

async function generateRestockNotification(baseNotification, itemsNeedingRestockNotification) {
    let restockMessage = baseNotification
    restockMessage += `*The following items had all on hand quantity in refurbished condition picked, These items have Used inventory available to be refurbished.* \n`
    restockMessage += `---\n`
    restockMessage += itemsNeedingRestockNotification.map(generateSkuRestockMessage).join('\n')

    return restockMessage
}

async function recordNotification(itemsNeedingRestockNotification) {
    const {results} = await PromisePool
        .for(itemsNeedingRestockNotification)
        .withConcurrency(10)
        .process(async (item) => {
            return await db.query(`
                INSERT INTO nfs.surtrics.restock_notifications (sku, refurbished_price, used_price)
                VALUES ($1, $2, $3)
            `, [item['sku'], item['refurbishedRetailPrice'], item['retail_price']])
        });
    return results
}

(async () => {
    let message, config, startDate;
    try {
        config = await getConfig()
        if (!config) {
            config = {
                debug: false,
                dryRun: false,
            }
            return new Error("No Config Found")
        }
        if(!config['lastRun']){
            let temp = new Date();
            temp = subDays(temp,1)
            temp = setHours(temp,0)
            temp = setMinutes(temp,0)
            temp = setSeconds(temp,0)
            temp = setMilliseconds(temp,0)
            config['lastRun'] = temp.toString()
            console.log("No Last Run Date Found, defaulting to yesterday")
        }
        startDate = new Date(config['lastRun'])
        console.log(`Last Run: ${startDate.toString()}`)
        let queryStartDate = startDate
        const endDate = addDays(startDate,1)
        let baseNotification = `** ${config['baseMessage']} ${startDate.toDateString()} - ${endDate.toDateString()} ** \n`
        const pickTransactions = await getPickTransactions(queryStartDate, endDate)
        console.log("Updating Last Run Date")
        config['lastRun'] = endDate.toString();
        await setConfig(config)
        console.log("Last Run Date Updated")
        if (config['debug']) {
            console.log("Pick Transactions")
            console.table(pickTransactions)
        }
        if (pickTransactions.length === 0) {
            console.log('No Pick Transactions matching query found in the date range')
            message = baseNotification + config['ErrorNoItems']
            if (!config['debug'] && !config['dryRun']) {
                await sendRingCentralMessage(message)
            }
            return
        }

        const usedComponents = await getUsedComponents(pickTransactions);
        if (config['debug']) {
            console.log("Used Components")
            console.table(usedComponents)
        }
        if (usedComponents.length === 0) {
            console.log('No Used Components found')
            message = baseNotification + config['ErrorNoUsedItems']
            if (!config['debug'] && !config['dryRun']) {
                await sendRingCentralMessage(message)
            }
            return
        }

        const itemsForRestock = await getItemsToRefurbFrom(usedComponents);
        if (config['debug']) {
            console.log("Items for restock")
            console.table(itemsForRestock)
        }
        if (itemsForRestock.length === 0) {
            console.log('No Items to restock from')
            message = baseNotification + config['ErrorNoItemsInStock']
            if (!config['debug'] && !config['dryRun']) {
                await sendRingCentralMessage(message)
            }
            return
        }
        console.log(config['MessageFoundItems'])
        message = await generateRestockNotification(baseNotification, itemsForRestock)

        if (config['debug']) {
            console.log(message)
        }
        if (!config['debug'] && !config['dryRun']) {
            console.log("Recording Notification")
            await recordNotification(itemsForRestock)
            console.log("Sending Notification")
            await sendRingCentralMessage(message)
            console.log("Sending Notification")
        }
        console.log("Notification Sent")
    } catch (error) {
        console.error(error)
        try {
            if (!config?.['debug'] && !config?.['dryRun']) {
                await sendRingCentralMessage(`**Error in Restock Notification** \n ${error.message}`)
            }
        } catch (e) {
            console.log("Error could not be sent to RingCentral")
            console.error(e)
        }
    }
})()