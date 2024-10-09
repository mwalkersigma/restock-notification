const RC_SDK = require('@ringcentral/sdk').SDK
const dotenv = require('dotenv')
dotenv.config()


const ChatId = process.env.CHAT_ID

async function getRingCentralPlatform() {
    if (!process.env.RC_JWT) {
        console.error('RingCentral JWT not found')
        return
    }
    const RingCentralSDK = new RC_SDK({
        'server': process.env.RC_SERVER_URL,
        'clientId': process.env.RC_CLIENT_ID,
        'clientSecret': process.env.RC_CLIENT_SECRET
    });
    let platform = RingCentralSDK.platform();
    await platform.login({
        jwt: process.env.RC_JWT
    })
    return RingCentralSDK.platform();
}

function getSuggestedColumns(size, min, max) {
    let results = Array
        .from({length: max}, (_, i) => i)
        .filter(i => size % i === 0 && i >= min)
    if (results.length > 1) {
        // optimize for the lease rows
        let minRows = Math.min(...results.map(i => size / i));
        return results.filter(i => size / i === minRows);
    }
    return results;
}

function splitToGrid(n, config = {}) {
    let minCols = config?.minCols || 2;
    let maxCols = config?.maxCols || 4;
    let forceCols = config?.forceCols || null;

    let size = n.length
    // find the smallest number <= maxCols that divides size most evenly
    let columnCount = forceCols ? forceCols :
        Math.min(maxCols,
            Math.max(minCols, ...getSuggestedColumns(size, minCols, maxCols))
        );
    let rowCount = Math.ceil(size / columnCount);
    let grid = [];
    let index = 0;
    for (let i = 0; i < rowCount; i++) {
        let row = [];
        for (let j = 0; j < columnCount; j++) {
            row.push(n[index]);
            index++;
        }
        grid.push(row);
    }
    return grid;
}

class RCCardData {
    /**
     * @param {Object} title
     * @param {String} title.text
     * @param {Object} dateRange
     * @param {String} dateRange.text
     * @param {Object} status
     * @param {String} status.text
     * @param {Object} description
     * @param {String} description.text
     * @param {Object[]} facts
     * @param {String} facts.key
     * @param {String} facts.value
     */
    constructor({title, dateRange, status, description, facts}) {
        this.title = title;
        this.status = status;
        this.description = description;
        this.facts = facts;
        this.dateRange = dateRange;
    }

}

function cardGenerator({title, dateRange, status, description, facts}) {
    let baseCard = {
        type: "AdaptiveCard",
        body: [
            {
                "type": "ColumnSet",
                "spacing": "Small",
                "columns": [
                    {
                        "type": "Column",
                        "items": [
                            {
                                ...{
                                    "type": "TextBlock",
                                    "size": "Medium",
                                    "weight": "Bolder",
                                    "text": "No Title Set",
                                },
                                ...title
                            }
                        ]
                    },
                    {
                        "type": "Column",
                        "verticalContentAlignment": "Center",
                        "items": [
                            {
                                ...{
                                    "type": "TextBlock",
                                    "text": "No Date Range",
                                    "size": "small",
                                    "wrap": true,
                                    "horizontalAlignment": "Right"
                                },
                                ...dateRange
                            }
                        ],
                    }
                ]
            }
        ],
        "actions": [],
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        version: "1.6"
    }
    if (status) {
        baseCard.body.push(
            {
                ...{
                    "type": "TextBlock",
                    "spacing": "Small",
                    "text": `Status: No Status Set`,
                    "color": "Good",
                    "isSubtle": true,
                    "weight": "Lighter",
                    "size": "medium",
                    "wrap": true,
                },
                ...status
            },
        )
    }
    if (description) {
        baseCard.body.push(
            {
                ...{
                    "type": "TextBlock",
                    "wrap": true,
                    "separator": true,
                    "spacing": "Medium",
                    "size": "Small",
                    "text": "No Description Set"
                },
                ...description
            }
        )
    }
    if (facts) {
        if (Array.isArray(facts)) {
            let maxColumns = 4
            let grid = splitToGrid(facts, {maxCols: maxColumns});
            let columnSet = {
                type: "ColumnSet",
                separator: true,
                spacing: "Large",
                columns: []
            }
            for (let row of grid) {
                for (let fact of row) {
                    let column = {
                        type: "Column",
                        width: "stretch",
                        separator: row.length !== 1
                    }
                    if (fact) {
                        column.items = [
                            {
                                type: "FactSet",
                                height: "stretch",
                                facts: [
                                    {
                                        title: fact.key,
                                        value: fact.value
                                    }
                                ]

                            }
                        ]
                        column.spacing = "medium"
                    }
                    columnSet.columns.push(column)
                }
                baseCard.body.push(columnSet)
                columnSet = {
                    type: "ColumnSet",
                    columns: [],
                    separator: true
                }
            }
        } else {
            baseCard.body.push({
                type: "TextBlock",
                text: facts,
                wrap: true
            })
        }
    }


    baseCard.body.push({
        "type": "TextBlock",
        "size": "small",
        "weight": "Lighter",
        "spacing": "ExtraLarge",
        "isSubtle": true,
        "color": "Dark",
        "horizontalAlignment": "Right",
        "text": "Automated message from the RingCentral API"
    })
    return baseCard
}

function cardFactory({title, dateRange, status, description, facts}) {
    let cardData = new RCCardData({
        title: {
            text: `${title}`
        },
        dateRange: {
            text: dateRange
        },
        status: {
            text: "No Status Set",
        },
        description: {
            text: "No Description Set"
        }
    })
    if (status) {
        console.log("Setting Status")
        cardData.status.text = status
    }
    if (description) {
        console.log("Setting Description")
        cardData.description.text = description
    }
    if (Array.isArray(facts)) {
        cardData.description.text += "\n" + facts.filter((message) => typeof message === 'string').join('\n')
        cardData.facts = facts
            .filter((message) => typeof message !== 'string')
            .filter(item => (item?.key && item?.value !== undefined))
            .map(({key, value}) => {
                return {
                    key,
                    value: value.toString()
                }
            })
    } else if (typeof facts === 'string' && facts !== "") {
        cardData.facts = facts
    }

    return cardData
}

class RCResponse {
    constructor(config) {
        this.id = config?.id;
        this.groupId = config?.groupId;
        this.type = config?.type;
        this.text = config?.text;
        this.creatorId = config?.creatorId;
        this.addPersonIds = config?.addPersonIds;
        this.creationTime = config?.creationTime;
        this.lastModifiedTime = config?.lastModifiedTime;
        this.attachments = config?.attachments;
        this.mentions = config?.mentions;
        this.activity = config?.activity;
        this.title = config?.title;
        this.iconUri = config?.iconUri;
        this.iconEmoji = config?.iconEmoji;
    }
}

async function sendCard(data, cardId) {
    if (ChatId === undefined) {
        console.error('ChatId not found')
        return
    }
    const platform = await getRingCentralPlatform();
    let resp
    if (cardId) {
        console.log('Updating Card')
        resp = await platform.put(`/team-messaging/v1/adaptive-cards/${cardId}`, data);
    } else {
        console.log('Creating Card')
        resp = await platform.post(`/team-messaging/v1/chats/${ChatId}/adaptive-cards`, data)
    }
    const json = await resp.json()
    return new RCResponse(json)
}

async function sendNotification(data) {
    let cardData = cardFactory(data)
    let card = cardGenerator(cardData)
    return await sendCard(card)
}

async function sendRingCentralMessage(message) {
    const platform = await getRingCentralPlatform();
    const baseMessage = {
        text: "",
    }
    baseMessage.text += message
    baseMessage.text += `\n`
    baseMessage.text += `---\n`
    return await platform.post(`/team-messaging/v1/chats/${ChatId}/posts`, baseMessage)
}

exports.sendRingCentralMessage = sendRingCentralMessage;
exports.sendCard = sendCard;
exports.cardGenerator = cardGenerator;
exports.cardFactory = cardFactory;
exports.sendNotification = sendNotification;
exports.RCResponse = RCResponse;





