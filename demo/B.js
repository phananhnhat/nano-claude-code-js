// File B: có dùng cơ sở dữ liệu
import { loadConfig } from './config.js';

export function startApp() {
  const cfg = loadConfig();
  const db = connect_db(cfg);
  return db;
}

export function runTests() {
  const testCfg = { name: 'test' };
  return connect_db(testCfg);
}
