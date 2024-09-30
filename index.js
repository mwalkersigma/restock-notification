require("dotenv").config();
const { db } = require('./modules/db');
const { PromisePool } = require('@supercharge/promise-pool')
const { subDays, addHours } = require('date-fns')
const {sendRingCentralMessage} = require("./modules/ringCentral");
const {formatter} = require("./modules/utils/numberFormatter");



async function getPickTransactions (startDate, endDate) {
    if(!startDate || !endDate) {
        throw new Error('Missing required fields')
    }
    if(!startDate instanceof Date || !endDate instanceof Date) {
        throw new Error('Invalid date format')
    }
    if(!startDate) {
        console.log("No Start Date Provided, defaulting to today")
        startDate = new Date()
    }
    if(!endDate) {
        console.log("No End Date Provided, defaulting to today")
        endDate = new Date()
    }
    console.log(`Querying Pick Transactions in the date range: ${startDate} - ${endDate}`)

    return await db.query(`
        SELECT t.*
        FROM surtrics.surplus_metrics_data t
        WHERE 
            transaction_type = 'Pick' 
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

async function getUsedComponentQuantity ( sku ) {
    if(!sku) {
        throw new Error('Missing required fields')
    }
    if(!sku.includes('-3')) {
        throw new Error('Invalid SKU format')
    }
    const refurbComponent = await db.query(`
        SELECT t.*
        FROM sursuite.components t
        WHERE sku = $1
    `, [sku]).then(res => res.rows[0])
    if(!refurbComponent) {
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
    * Used Retail Price: ${formatter(item['retail_price'],'currency')}
    * Refurbished Retail Price: ${formatter(item['refurbishedRetailPrice'], 'currency')}
    * Potential Revenue Per Item: ${formatter(item['potentialRevenuePerItem'], 'currency')}
`
}
async function generateRestockNotification (baseNotification,pickTransactions) {
    let restockMessage = baseNotification

    const {results} = await PromisePool
        .for(pickTransactions)
        .withConcurrency(10)
        .process(async (transaction) => getUsedComponentQuantity(transaction['sku']));
    console.log("\n")

    const itemsNeedingRestockNotification = results
        .filter(item => item['quantity'] > 0)
        .map(generateSkuRestockMessage)

    if (itemsNeedingRestockNotification.length === 0) {
        restockMessage += `No Items found that can be refurbished with used inventory. ( We sold all of our refurbished inventory and have no used inventory to refurbish )`
        return restockMessage
    }
    restockMessage += `*The following items had all on hand quantity in refurbished condition picked, These items have Used inventory available to be refurbished.* \n`
    restockMessage += `---\n`
    restockMessage += itemsNeedingRestockNotification.join('\n')

    return restockMessage
}


(async () => {
    try {
        const endDate = addHours(new Date('2024-09-19'),5)
        const startDate = subDays(endDate,1)
        let baseNotification = `** Restock Notification For : ${startDate.toDateString()} ** \n`
        const pickTransactions = await getPickTransactions(startDate, endDate)

        let message;
        if(pickTransactions.length === 0) {
            console.log('No Pick Transactions found in the date range')
            message = baseNotification + 'No Items Requiring Refurbishment Found'
        }else{
           message = await generateRestockNotification(baseNotification, pickTransactions)
        }


        try {
           await sendRingCentralMessage(message);
            // console.log(message)
        } catch (e) {
            console.error(e)
        }


    } catch (error) {
        console.error(error)
    }
})()