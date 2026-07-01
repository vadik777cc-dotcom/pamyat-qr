require('dotenv').config();
const { defineConfig, devices } = require('@playwright/test');
const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.APP_BASE_URL || `http://127.0.0.1:${PORT}`;
module.exports = defineConfig({
  testDir:'./tests', timeout:90000, expect:{timeout:15000}, fullyParallel:false, retries:0, workers:1,
  reporter:[['html',{open:'never'}],['list']],
  use:{baseURL:BASE_URL, trace:'retain-on-failure', screenshot:'only-on-failure', video:'retain-on-failure', actionTimeout:20000, navigationTimeout:30000},
  projects:[
    {name:'desktop-chromium', use:{...devices['Desktop Chrome'], viewport:{width:1440,height:950}}},
    {name:'mobile-safari', use:{...devices['iPhone 14']}}
  ],
  webServer:{command:'npm start', url:BASE_URL+'/healthz', reuseExistingServer:true, timeout:120000, env:{NODE_ENV:'development', DISABLE_RATE_LIMITS:'1'}}
});
