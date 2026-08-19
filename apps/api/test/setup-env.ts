import * as path from 'node:path';
import * as dotenv from 'dotenv';

// Load repo-root .env for local runs; CI provides env directly.
dotenv.config({
  path: [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')],
});
