import dotenv from 'dotenv'
import { createApp } from './app.ts'
import { isPostgres } from './db/db.ts'
import { LOCAL_UPLOADS, isS3Configured } from './services/storage.ts'

dotenv.config()

const PORT = Number(process.env.PORT) || 5001

const app = await createApp()

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] COI Tracker API running on http://0.0.0.0:${PORT}`)
  console.log(`[server] Database: ${isPostgres ? 'PostgreSQL' : 'SQLite'}`)
  console.log(`[server] File storage: ${isS3Configured ? 'AWS S3 (' + process.env.AWS_S3_BUCKET + ')' : 'local disk (' + LOCAL_UPLOADS + ')'}`)
})
