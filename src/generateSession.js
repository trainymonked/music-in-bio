import 'dotenv/config'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

const apiId = Number(process.env.TELEGRAM_API_ID)
const apiHash = process.env.TELEGRAM_API_HASH

if (!apiId || !apiHash) {
  console.error('TELEGRAM_API_ID and TELEGRAM_API_HASH are required in .env')
  process.exit(1)
}

const rl = readline.createInterface({ input, output })

try {
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  })

  await client.start({
    phoneNumber: async () => rl.question('Phone number (international format): '),
    password: async () => rl.question('2FA password (if set, else press Enter): '),
    phoneCode: async () => rl.question('Code from Telegram: '),
    onError: error => {
      throw error
    },
  })

  console.log('\nSession string (save to TELEGRAM_SESSION_STRING):\n')
  console.log(client.session.save())
} finally {
  rl.close()
}
