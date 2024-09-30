const RC_SDK = require('@ringcentral/sdk').SDK
const dotenv = require('dotenv')
dotenv.config()


const ChatId = '139466260486'
async function sendRingCentralMessage(message) {
    const RingCentralSDK = new RC_SDK({
        'server': process.env.RC_SERVER_URL,
        'clientId': process.env.RC_CLIENT_ID,
        'clientSecret': process.env.RC_CLIENT_SECRET
    });
    const platform = RingCentralSDK.platform();
    if (!process.env.RC_JWT) {
        console.error('RingCentral JWT not found')
        return
    }
    const baseMessage = {
        text: "",
    }
    baseMessage.text += message
    baseMessage.text += `\n`
    baseMessage.text += `---\n`
    await platform.login({
        jwt: process.env.RC_JWT
    })
    return await platform.post(`/team-messaging/v1/chats/${ChatId}/posts`, baseMessage)
}

exports.sendRingCentralMessage = sendRingCentralMessage;





