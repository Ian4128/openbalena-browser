const express = require('express');
const axios = require('axios');
const qs = require('qs');

const app = express();
const port = 3000;

const keycloakDomain = process.env.OIDC_ISSUER_URL;  // Keycloak domain from environment
const clientId = process.env.OIDC_CLIENT_ID;
const clientSecret = process.env.OIDC_CLIENT_SECRET;

// Serve the device verification page
app.get('/device-verification', async (req, res) => {
  try {
    // Request device code from Keycloak
    const response = await axios.post(
      `${keycloakDomain}/protocol/openid-connect/auth/device`,
      qs.stringify({
        client_id: clientId,
        client_secret: clientSecret,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { device_code, user_code, verification_uri, verification_uri_complete, interval, expires_in } = response.data;

    // Display user code and verification URI to the user
    res.send(`
      <html>
      <body style="text-align: center; font-family: Arial, sans-serif;">
        <h2>Authenticate Your Device</h2>
        <p>Go to <a href="${verification_uri}" target="_blank">${verification_uri}</a> on another device.</p>
        <p>Enter the code: <strong>${user_code}</strong></p>
        <script>
          // Start polling for authorization status
          fetch('/poll?device_code=${device_code}&interval=${interval}')
            .then(response => response.json())
            .then(data => {
              if (data.access_token) {
                document.body.innerHTML = '<h2>Authentication Complete</h2><p>You can now use this device.</p>';
              }
            })
            .catch(error => console.error('Polling error:', error));
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send('Error requesting device authorization.');
    console.error('Error:', error);
  }
});

// Poll Keycloak for user authorization
app.get('/poll', async (req, res) => {
  const { device_code, interval } = req.query;

  const pollForToken = async () => {
    try {
      const tokenResponse = await axios.post(
        `${keycloakDomain}/protocol/openid-connect/token`,
        qs.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: device_code,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      res.json({ access_token: tokenResponse.data.access_token });
    } catch (error) {
      if (error.response && error.response.data.error === 'authorization_pending') {
        setTimeout(pollForToken, interval * 1000); // Retry polling after the specified interval
      } else {
        console.error('Polling error:', error.response?.data || error);
        res.status(500).json({ error: 'Polling failed' });
      }
    }
  };

  pollForToken();
});

// Start the Express server
app.listen(port, () => {
  console.log(`Device authorization server listening at http://localhost:${port}`);
});
