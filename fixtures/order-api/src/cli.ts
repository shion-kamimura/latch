import { listen } from './server.ts';

const port = Number(process.env.PORT ?? '0');
const baseUrl = await listen(Number.isInteger(port) ? port : 0);
process.stdout.write(`listening on ${baseUrl}\n`);
