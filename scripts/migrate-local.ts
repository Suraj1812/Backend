import { localDatabase } from './local-runtime';
const { pg } = await localDatabase();
await pg.close();
console.log('Applied local PostgreSQL migrations.');
