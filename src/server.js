#!/bin/env node

const express = require('express');
const bodyParser = require('body-parser');
const chromeLauncher = require('chrome-launcher');
const bent = require('bent');
const { Issuer, generators } = require('openid-client');
const {
  setIntervalAsync,
  clearIntervalAsync
} = require('set-interval-async/dynamic');
const { spawn } = require('child_process');
const { readFile, unlink } = require('fs').promises;
const path = require('path');
const os = require('os');

// Bring in the static environment variables
const API_PORT = parseInt(process.env.API_PORT) || 5011;
const WINDOW_SIZE = process.env.WINDOW_SIZE || "800,600";
const WINDOW_POSITION = process.env.WINDOW_POSITION || "0,0";
const PERSISTENT_DATA = process.env.PERSISTENT || '0';
const REMOTE_DEBUG_PORT = process.env.REMOTE_DEBUG_PORT || 35173;
const FLAGS = process.env.FLAGS || null;
const EXTRA_FLAGS = process.env.EXTRA_FLAGS || null;
const HTTPS_REGEX = /^https?:\/\//i; //regex for HTTP/S prefix
const AUTO_REFRESH = process.env.AUTO_REFRESH || 0;

// Environment variables which can be overriden from the API
let kioskMode = process.env.KIOSK || '0';
let enableGpu = process.env.ENABLE_GPU || '0';

let DEFAULT_FLAGS = [];
let currentUrl = '';
let flags = [];

// OIDC configuration
const OIDC_ISSUER = process.env.OIDC_ISSUER; // e.g., "https://accounts.example.com"
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID;
const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET;
const OIDC_REDIRECT_URI = process.env.OIDC_REDIRECT_URI || "http://localhost:5011/oidc/callback";
let accessToken = null;

async function getOIDCClient() {
  if (!OIDC_ISSUER || !OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET) {
    throw new Error("OIDC environment variables not set.");
  }

  const oidcIssuer = await Issuer.discover(OIDC_ISSUER);
  const client = new oidcIssuer.Client({
    client_id: OIDC_CLIENT_ID,
    client_secret: OIDC_CLIENT_SECRET,
    redirect_uris: [OIDC_REDIRECT_URI],
    response_types: ['code'],
  });
  
  return client;
}

async function authenticateWithOIDC() {
  const client = await getOIDCClient();
  const authorizationUrl = client.authorizationUrl({
    scope: 'openid profile email',
    response_mode: 'query',
    nonce: generators.nonce(),
    state: generators.state(),
  });

  // This should trigger a browser redirection to the authorizationUrl
  console.log(`Open the following URL to authenticate with OIDC:\n${authorizationUrl}`);
}

// Handler for OIDC callback to get the token
async function handleOIDCCallback(req, res) {
  const client = await getOIDCClient();
  const params = client.callbackParams(req);
  const tokenSet = await client.callback(OIDC_REDIRECT_URI, params, { nonce: generators.nonce() });

  accessToken = tokenSet.access_token;
  console.log("Access token obtained:", accessToken);
  res.send('OIDC authentication successful. You can now use the application.');
}

// Add token to headers for authenticated requests
async function bentWithAuth(url) {
  const getJSON = bent('json', 200, { Authorization: `Bearer ${accessToken}` });
  return await getJSON(url);
}

// Modifications to launchChromium to handle OIDC
async function getUrlToDisplayAsync() {
  // ... existing logic remains the same ...
  const url = await findLocalServiceUrl() || "file:///home/chromium/index.html";
  
  if (accessToken) {
    console.log("Launching URL with OIDC token.");
  } else {
    console.log("Launching URL without OIDC token.");
  }

  return url;
}  // Configuration as before...

async function launchChromium(url) {
  await chromeLauncher.killAll();
  flags = [];
    // If the user has set the flags, use them
    if (null !== FLAGS)
    {
      flags = FLAGS.split(' ');
    }
    else
    {
      // User the default flags from chrome-launcher, plus our own.
      flags = DEFAULT_FLAGS;
      let balenaFlags = [
        '--window-size=' + WINDOW_SIZE,
        '--window-position=' + WINDOW_POSITION,
        '--autoplay-policy=no-user-gesture-required',
        '--noerrdialogs',
        '--disable-session-crashed-bubble',
        '--check-for-update-interval=31536000',
        '--disable-dev-shm-usage', // TODO: work out if we can enable this for devices with >1Gb of memory
      ];

      // Merge the chromium default and balena default flags
      flags = flags.concat(balenaFlags);

      // either disable the gpu or set some flags to enable it
      if (enableGpu != '1')
      {
        console.log("Disabling GPU");
        flags.push('--disable-gpu');
      }
      else
      {
        console.log("Enabling GPU");
        let gpuFlags = [
          '--enable-zero-copy',
          '--num-raster-threads=4',
          '--ignore-gpu-blocklist',
          '--enable-gpu-rasterization',
        ];

        flags = flags.concat(gpuFlags);
      }
    }

    if (EXTRA_FLAGS) {
      flags = flags.concat(EXTRA_FLAGS.split(' '));
    }

    let startingUrl = url;
    if ('1' === kioskMode)
    {
      console.log("Enabling KIOSK mode");
      startingUrl = `--app= ${url}`;
    }
    else
    {
      console.log("Disabling KIOSK mode");
    }

    console.log(`Starting Chromium with flags: ${flags}`);
    console.log(`Displaying URL: ${startingUrl}`);

    const chrome = await chromeLauncher.launch({
      startingUrl: startingUrl,
      ignoreDefaultFlags: true,
      chromeFlags: flags,
      port: REMOTE_DEBUG_PORT,
      connectionPollInterval: 1000,
      maxConnectionRetries: 120,
      userDataDir: '1' === PERSISTENT_DATA ? '/data/chromium' : undefined
    });
  
  console.log(`Chromium remote debugging tools running on port: ${chrome.port}`);
  currentUrl = url;
}

// Add Express API for initiating OIDC flow and callback
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// New endpoint for initiating OIDC authentication
app.get('/oidc/login', async (req, res) => {
  await authenticateWithOIDC();
  res.send("Please authenticate with OIDC using the printed URL.");
});

// OIDC callback endpoint
app.get('/oidc/callback', async (req, res) => {
  try {
    await handleOIDCCallback(req, res);
  } catch (err) {
    console.log("OIDC callback error:", err);
    res.status(500).send("OIDC authentication failed.");
  }
});

// Existing endpoints
app.get('/ping', (req, res) => res.status(200).send('ok'));
app.post('/url', async (req, res) => {
  if (!req.body.url) {
    return res.status(400).send('Bad request: missing URL in the body element');
  }

  let url = req.body.url;

  // prepend http prefix if necessary for kiosk mode to work
  if (!HTTPS_REGEX.test(url)) {
    url = 'http://' + url;
  }

  if (req.body.kiosk) {
    kioskMode = req.body.kiosk;
  }

  if (req.body.gpu) {
    enableGpu = req.body.gpu;
  }

  launchChromium(url);
  return res.status(200).send('ok');
});
app.get('/url', (req, res) => res.status(200).send(currentUrl));

app.post('/refresh', async (req, res) => {
  launchChromium(currentUrl);
  return res.status(200).send('ok');
});

app.listen(API_PORT, () => console.log('Browser API running on port:', API_PORT));

async function SetDefaultFlags() {
  DEFAULT_FLAGS =  await chromeLauncher.Launcher.defaultFlags().filter(flag => '--disable-extensions' !== flag && '--mute-audio' !== flag);
}

async function setTimer(interval) {
  console.log("Auto refresh interval: ", interval);
  timer = setIntervalAsync(
    async () => {
      try {
        await launchChromium(currentUrl);
      } catch (err) {
        console.log("Timer error: ", err);
        process.exit(1);
      }
    },
    interval
  )
}

async function clearTimer(){
  await clearIntervalAsync(timer);
}

async function main(){
  await SetDefaultFlags();
  let url = await getUrlToDisplayAsync();
  await launchChromium(url);
  if (AUTO_REFRESH > 0)
  {
    await setTimer(AUTO_REFRESH * 1000);
  }
}


main().catch(err => {
  console.log("Main error: ", err);
  process.exit(1);
});


const errorHandler = (err, req, res, next) => {
  res.status(500);
  res.render('API error: ', {
    error: err
  });
};

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});
app.use(errorHandler);


// gpu set endpoint
app.post('/gpu/:gpu', (req, res) => {
  if (!req.params.gpu) {
    return res.status(400).send('Bad Request');
  }

  if('1' !== req.params.gpu && '0' !== req.params.gpu)
  {
    return res.status(400).send('Bad Request');
  }

  enableGpu = req.params.gpu;
  launchChromium(currentUrl);
  return res.status(200).send('ok');
});
// gpu get endpoint
app.get('/gpu', (req, res) => {
    
  return res.status(200).send(enableGpu.toString());
});

// kiosk set endpoint
app.post('/kiosk/:kiosk', (req, res) => {
  if (!req.params.kiosk) {
    return res.status(400).send('Bad Request');
  }

  kioskMode = req.params.kiosk;
  launchChromium(currentUrl);
  return res.status(200).send('ok');
});

app.post('/autorefresh/:interval', async(req, res) => {
  if (!req.params.interval) {
    return res.status(400).send('Bad Request');
  }

  if(req.params.interval < 1)
  {
    await clearTimer();
  }
  else
  {
    await setTimer((req.params.interval * 1000))
  }
  
  return res.status(200).send('ok');
});

// flags endpoint
app.get('/flags', (req, res) => { 
    
  return res.status(200).send(flags.toString());
});

// kiosk get endpoint
app.get('/kiosk', (req, res) => {
    
  return res.status(200).send(kioskMode.toString());
});

// version get endpoint
app.get('/version', (req, res) => {
  
  let version = process.env.VERSION || "Version not set";
  return res.status(200).send(version.toString());
});

app.get('/screenshot', async(req, res) => {
  const fileName = process.hrtime.bigint() + '.png';
  const filePath = path.join(os.tmpdir(), fileName);
  try {
    const child = spawn('scrot', [filePath]);

    const statusCode = await new Promise( (res, rej) => { child.on('close', res); } );
    if (statusCode != 0) {
      return res.status(500).send("Screenshot command exited with non-zero return code.");
    }

    const fileContents = await readFile(filePath);
    res.set('Content-Type', 'image/png');
    return res.status(200).send(fileContents);
  } catch(e) {
    console.log(e.toString());
    return res.status(500).send("Error occurred in screenshot code.");
  } finally {
    try {
      await unlink(filePath);
    } catch (e) {
      console.log(e)
    }
  }
});

// scan endpoint - causes the device to rescan for local HTTP services
app.post('/scan', (req, res) => {
 
  main().catch(err => {
    console.log("Scan error: ", err);
    process.exit(1);
  });
  return res.status(200).send('ok');
});

app.listen(API_PORT, () => {
  console.log('Browser API running on port: ' + API_PORT);
});

process.on('SIGINT', () => {
  process.exit();
});