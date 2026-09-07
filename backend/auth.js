const { ConfidentialClientApplication } = require('@azure/msal-node');

const SCOPES = ['openid', 'profile', 'email', 'User.Read'];

let cca = null;

function getClient() {
  if (!process.env.AZURE_AD_CLIENT_ID || !process.env.AZURE_AD_CLIENT_SECRET || !process.env.AZURE_AD_TENANT_ID) {
    throw new Error('Azure AD is not configured — set AZURE_AD_CLIENT_ID, AZURE_AD_CLIENT_SECRET and AZURE_AD_TENANT_ID in .env');
  }
  if (!cca) {
    cca = new ConfidentialClientApplication({
      auth: {
        clientId: process.env.AZURE_AD_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID}`,
        clientSecret: process.env.AZURE_AD_CLIENT_SECRET
      }
    });
  }
  return cca;
}

async function exchangeCodeForToken(code) {
  return getClient().acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: process.env.AZURE_AD_REDIRECT_URI
  });
}

module.exports = { exchangeCodeForToken };
