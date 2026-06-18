import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { createAuthRouter } from './routes/auth';


dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

async function checkDatabaseConnection() {
    try {
        const client = await pool.connect();
        console.log('Успешное подключение к бд');
        client.release();
    } catch (err) {
        console.error('Ошибка при подключении к бд', err);
    }
}

app.use(cors());
app.use(express.json());

app.use('/api/auth',createAuthRouter(pool));

app.get('/', (req: Request, res: Response) => {
    res.send('Сервер запущен');
});

app.listen(PORT, async () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
    
    await checkDatabaseConnection();
});