require("dotenv").config();
const {db} = require('./modules/db');
const {PromisePool} = require('@supercharge/promise-pool')
const {subDays, addHours} = require('date-fns')
const {sendRingCentralMessage} = require("./modules/ringCentral");
const {formatter} = require("./modules/utils/numberFormatter");


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
    console.log(`Querying Pick Transactions in the date range: ${startDate} - ${endDate}`)

    return await db.query(`
        SELECT t.*
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
    const refurbComponent = await db.query(`
        SELECT t.*
        FROM sursuite.components t
        WHERE sku = $1
    `, [sku]).then(res => res.rows[0])
    if (!refurbComponent) {
        throw new Error('Refurbished Component not found')
    }
    console.log(refurbComponent['retail_price'])
    sku = sku.replace('-3', '-4')
    console.log(`Querying Used Component Quantity for SKU: ${sku}`)

    const usedComponent = await db.query(`
        SELECT t.*
        FROM sursuite.components t
        WHERE sku = $1
    `, [sku])
        .then(res => res.rows[0])
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

async function getItemsNeedingRestock(usedComponents) {
    return usedComponents
        .filter(item => item['quantity'] > 0)
}

async function generateRestockNotification(baseNotification, itemsNeedingRestockNotification) {
    let restockMessage = baseNotification

    if (itemsNeedingRestockNotification.length === 0) {
        restockMessage += `No Items found that can be refurbished with used inventory. ( We sold all of our refurbished inventory and have no used inventory to refurbish )`
        return restockMessage
    }
    restockMessage += `*The following items had all on hand quantity in refurbished condition picked, These items have Used inventory available to be refurbished.* \n`
    restockMessage += `---\n`
    restockMessage += itemsNeedingRestockNotification.map(generateSkuRestockMessage).join('\n')

    return restockMessage
}

async function recordNotification(itemsNeedingRestockNotification) {
    const {results} = await PromisePool
        .for(itemsNeedingRestockNotification)
        .withConcurrency(10)
        .process(async (item) =>{
            return await db.query(`
                INSERT INTO nfs.surtrics.restock_notifications ( sku, refurbished_price, used_price ) 
                VALUES ($1, $2, $3)
            `, [item['sku'], item['refurbishedRetailPrice'], item['retail_price']])
        });
    return results
}

(async () => {
    let message;
    try {
        const endDate = addHours(new Date('2024-09-19'), 5)
        const startDate = subDays(endDate, 1)
        let baseNotification = `** Restock Notification For : ${startDate.toDateString()} ** \n`
        const pickTransactions = await getPickTransactions(startDate, endDate)

        if (pickTransactions.length === 0) {
            console.log('No Pick Transactions found in the date range')
            message = baseNotification + 'No Items Requiring Refurbishment Found'
            await sendRingCentralMessage(message)
            return
        }
        const usedComponents = await getUsedComponents(pickTransactions);
        if (usedComponents.length === 0) {
            console.log('No Used Components found in the date range')
            message = baseNotification + 'No Items Requiring Refurbishment Found'
            await sendRingCentralMessage(message)
            return
        }
        const itemsNeedingRestock = await getItemsNeedingRestock(usedComponents);
        if (itemsNeedingRestock.length === 0) {
            console.log('No Items needing restock found in the date range')
            message = baseNotification + 'No Items Requiring Refurbishment Found'
            await sendRingCentralMessage(message)
            return
        }
        console.log("Found Items needing restock");
        console.table(itemsNeedingRestock)
        console.log("Recording Notification to Database")
        await recordNotification(itemsNeedingRestock)
        console.log("Generating Restock Notification")
        message = await generateRestockNotification(baseNotification, itemsNeedingRestock)
        console.log("Sending Notification")
        console.log(message)
        await sendRingCentralMessage(message)
        console.log("Notification Sent")

    } catch (error) {
        console.error(error)
        try {
            await sendRingCentralMessage(`**Error in Restock Notification** \n ${error.message}`)
        } catch (e) {
            console.log("Error could not be sent to RingCentral")
            console.error(e)
        }
    }
})()