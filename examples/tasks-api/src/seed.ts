// npm run seed: demo accounts and a project, in the database of the app.
import { loadConfig } from './config.ts'
import { openDatabase } from './db/database.ts'
import { DEMO_PASSWORD, seedDemo } from './demo-data.ts'

const config = loadConfig()
if (config.production) {
  throw new Error('The demo data is for development only.')
}

const db = openDatabase(config.DATABASE_PATH)
const result = await seedDemo(db)
db.close()

console.log(
  result.created
    ? `Demo data created in ${config.DATABASE_PATH}.`
    : 'Demo data already present.'
)
console.log(
  `Log in as alice@example.com or bob@example.com, password "${DEMO_PASSWORD}".`
)
