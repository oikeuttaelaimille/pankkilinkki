import { Osuuspankki, Key } from "pankkiyhteys";

import { promises as fs } from "fs";

const USERNAME = "";
const LANGUAGE = "FI";
const ENVIRONMENT = "TEST";
const TRANSFER_KEY = "";

async function main() {
  const privateKey = await Key.generateKey();

  console.log(privateKey);

  await fs.writeFile(`private-key-${new Date().toISOString()}.key`, privateKey);

  const client = new Osuuspankki(USERNAME, undefined, LANGUAGE);

  const cert = await client.getInitialCertificate(privateKey, TRANSFER_KEY);

  console.log(cert);

  await fs.writeFile(`certificate-${new Date().toISOString()}.pem`, cert);
}

main();
