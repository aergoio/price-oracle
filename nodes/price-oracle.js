const client = require('@herajs/client');
const crypto = require('@herajs/crypto');
const process = require('process');
const fs = require('fs');
const { initialize_event_handling, terminate_event_handling } = require('./contract-events.js');
const { get_aergo_prices } = require('./aergo-price.js');

// This is the address of the Aergo Price Oracle contract
// You'll need to replace these with your actual contract addresses
const contract_address_testnet = "AmgGLqBZa5VxnK6wbXMngGA2S3eK5aEfPkvd46Mixb77XbrJpiRu"
const contract_address_mainnet = "AmgGLqBZa5VxnK6wbXMngGA2S3eK5aEfPkvd46Mixb77XbrJpiRu"
var contract_address
var network_address
const gas_price = 5  // 50000000000
const gas_limit = 100000

var chainIdHash
var identity
var account

// File path for storing the last sent prices
const lastPricesFilePath = __dirname + '/last_price.json';

let last_round = 0;

// Variable to store the last prices, received from contract events
let last_prices = {};

// Variable to store the last prices, fetched from exchanges
let last_fetched_prices = {};

// Track if this node is active (successfully submitting prices)
let node_is_active = false;
// Timer for fetching and submitting prices
let fetch_timer = null;
// Timer for delayed price submission
let submission_timer = null;

// Track the last round in which this node has submitted prices
let last_submitted_round = 0;

// read the command line argument
const args = process.argv.slice(2)
if (args.length == 0 || (args[0] != 'testnet' && args[0] != 'mainnet' && args[0] != 'local')) {
  var path = require("path");
  var file = path.basename(process.argv[1])
  console.log("node", file, "local")
  console.log(" or")
  console.log("node", file, "testnet")
  console.log(" or")
  console.log("node", file, "mainnet")
  process.exit(1)
}
if (args[0] == 'mainnet') {
  console.log('running on mainnet')
  network_address = 'mainnet-api.aergo.io:7845'
  contract_address = contract_address_mainnet
} else if (args[0] == 'testnet') {
  console.log('running on testnet')
  network_address = 'testnet-api.aergo.io:7845'
  contract_address = contract_address_testnet
} else if (args[0] == 'local') {
  console.log('running on local network')
  network_address = '127.0.0.1:7845'
  contract_address = process.env.PRICE_ORACLE_CONTRACT
  if (!contract_address) {
    console.error("Environment variables for contract addresses not set");
    process.exit(1);
  }
}

const aergo = new client.AergoClient({}, new client.GrpcProvider({url: network_address}));

// read or generate an account for this node
try {
  const privateKey = fs.readFileSync(__dirname + '/account.data')
  console.log('reading account from file...')
  identity = crypto.identityFromPrivateKey(privateKey)
} catch (err) {
  if (err.code == 'ENOENT') {
    console.log('generating new account...')
    identity = crypto.createIdentity()
    fs.writeFileSync(__dirname + '/account.data', identity.privateKey)
  } else {
    console.error(err)
    process.exit(1)
  }
}

console.log('account address:', identity.address);


// Function to read last prices from file
function read_last_prices_from_file() {
  try {
    const data = fs.readFileSync(lastPricesFilePath, 'utf8');
    const savedData = JSON.parse(data);
    // If the saved data has a round property, update last_round
    if (savedData.round !== undefined) {
      last_round = savedData.round;
    }
    // Update the global last_prices variable
    last_prices = savedData.prices || {};
    console.log('Last prices and round loaded from file. Round:', last_round);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('No previous prices file found, will create one on first event');
      last_prices = {};
    } else {
      console.error('Error reading last prices file:', err);
      last_prices = {};
    }
  }
}

// Function to write last prices to file
function write_last_prices_to_file() {
  try {
    // Create an object that includes both the round and prices
    const obj = {
      round: last_round,
      prices: last_prices
    };
    fs.writeFileSync(lastPricesFilePath, JSON.stringify(obj, null, 2));
    console.log('Last prices and round saved to file');
  } catch (err) {
    console.error('Error writing last prices to file:', err);
  }
}

function shutdown_node(exit_code) {
  console.log("Shutting down this node...");
  // clear any pending timers
  if (submission_timer) {
    clearTimeout(submission_timer);
    submission_timer = null;
  }
  if (fetch_timer) {
    clearTimeout(fetch_timer);
    fetch_timer = null;
  }
  // stop event handling
  terminate_event_handling();
  // wait for 5 seconds before shutting down
  setTimeout(() => {
    process.exit(exit_code);
  }, 5000);
}

// Function to handle price update events
function on_prices_updated(event, is_new) {
  try {
    // The event contains the prices table directly
    last_round = event.args[0];
    last_prices = event.args[1];
    console.log("last prices from contract at round", last_round, "are:", last_prices);
    // Save to file for persistence
    write_last_prices_to_file();
    // Clear any pending timers when prices are updated
    if (submission_timer) {
      clearTimeout(submission_timer);
      submission_timer = null;
    }
    if (fetch_timer) {
      clearTimeout(fetch_timer);
      fetch_timer = null;
    }
    // Set a timer to fetch and submit prices at every 5 minutes (repeat because the prices may not differ much)
    fetch_timer = setInterval(fetch_and_submit_prices, 5 * 60 * 1000);
  } catch (error) {
    console.error("Error processing prices from event:", error);
  }
}

// Function to handle contract events
function on_contract_event(event, is_new) {
  console.log("Received contract event:", event.eventName);

  if (event.eventName === "prices_updated") {
    on_prices_updated(event, is_new);
  //} else if (event.eventName === "price_submitted") {
  //  on_price_submitted(event, is_new);
  }
}

// Function to check if prices have changed by at least 2%
function prices_changed_significantly(newPrices, oldPrices) {
  if (Object.keys(oldPrices).length === 0) return true;

  for (const [currency, priceStr] of Object.entries(newPrices)) {
    const oldPriceStr = oldPrices[currency];
    if (!oldPriceStr) return true; // If we don't have an old price for this currency

    // Convert string prices to numbers for comparison
    const price = parseInt(priceStr, 10);
    const oldPrice = parseInt(oldPriceStr, 10);

    const percentChange = Math.abs((price - oldPrice) / oldPrice * 100);
    if (percentChange >= 2) {
      console.log(`${currency} price changed by ${percentChange.toFixed(2)}% (${oldPrice} -> ${price})`);
      return true;
    }
  }

  console.log('No significant price changes (< 2%), skipping submission');
  return false;
}

// Function to format prices correctly for the contract
function formatPricesForContract(prices) {
  const formattedPrices = {};

  for (const [currency, price] of Object.entries(prices)) {
    // Convert floating point price to string with 4 implied decimal places
    // For example: 1.23 -> "12300"
    const priceAsInteger = Math.round(price * 10000).toString();
    formattedPrices[currency] = priceAsInteger;
  }

  return formattedPrices;
}

// send the price to the Aergo Price Oracle smart-contract
async function submit_price(round, prices) {

  if (account.nonce == 0) {
    account = await aergo.getState(identity.address)
  }
  account.nonce += 1

  const tx = {
    //type: 5,  // contract call
    type: 3,  // contract call with fee delegation
    nonce: account.nonce,
    from: identity.address,
    to: contract_address,
    payload: JSON.stringify({
      "Name": "submit_price",
      "Args": [round, prices]
    }),
    amount: '0 aer',
    limit: gas_limit,
    chainIdHash: chainIdHash
  };

  console.log("sending transaction with prices:", prices)

  try {
    tx.sign = await crypto.signTransaction(tx, identity.keyPair);
    tx.hash = await crypto.hashTransaction(tx, 'bytes');
    const txhash = await aergo.sendSignedTransaction(tx);
    const txReceipt = await aergo.waitForTransactionReceipt(txhash);

    console.log("transaction receipt:", txReceipt)

    // Update node_is_active based on transaction success
    if (txReceipt.status === "SUCCESS") {
      node_is_active = true;
      console.log("Node is now marked as active");
    } else {
      node_is_active = false;
      console.log("Node is now marked as inactive due to failed transaction");
    }
    return true;
  } catch (error) {
    console.error("Error submitting price:", error)
    node_is_active = false;
    account.nonce = 0;
    console.log("Node is now marked as inactive due to transaction error");

    if (error.message.includes('ECONNRESET') || 
        error.message.includes('connection') || 
        error.message.includes('network')) {
      shutdown_node(1);
    }
    return false;
  }
}

async function submit_prices(current_round, prices) {

  if (last_submitted_round == 0) {
    // check if this node has already submitted prices for this round and if the round is still open
    try {
      const result = await aergo.queryContract(contract_address, "check_submission", [current_round, identity.address]);
      if (result != "OK") {
        console.log("This node has already submitted prices for this round or the round is over");
        return;
      }
    } catch (error) {
      console.error("Error checking submission:", error);
      shutdown_node(1);
      return;
    }
  }

  // Submit prices to the smart contract
  submit_price(current_round, prices)
    .then(success => {
      if (!success) {
        console.log("Failed to submit prices to the blockchain");
        return;
      }
      console.log("Successfully submitted prices to the blockchain");
      // Only update last_submitted_round on success
      last_submitted_round = current_round;
    })
    .catch(error => {
      console.error("Error in price submission process:", error);
    });

}

// Fetch prices and submit them to the blockchain
function fetch_and_submit_prices() {
  // Get the current prices from the exchanges
  get_aergo_prices(function(current_prices) {
    console.log("AERGO prices:", current_prices);

    // Check if prices are valid (non-null and non-zero)
    if (!current_prices ||
        !current_prices.USD || current_prices.USD === 0 ||
        !current_prices.KRW || current_prices.KRW === 0) {
      console.log("Skipping submission - invalid or missing prices:", current_prices);
      return;
    }

    // Format prices for the contract
    current_prices = formatPricesForContract(current_prices);
    console.log("AERGO prices (formatted for contract):", current_prices);

    // Check if prices have not changed significantly
    if (!prices_changed_significantly(current_prices, last_prices)) {
      console.log("Skipping submission - no significant price changes");
      return;
    }

    var current_round = last_round + 1;

    // check if this node has already submitted prices for this round
    if (last_submitted_round >= current_round) {
      console.log("Skipping submission - already submitted prices for this round");
      return;
    }

    // If this node is active, submit prices immediately
    if (node_is_active) {
      submit_prices(current_round, current_prices);
    } else if (!submission_timer) {
      // If this node is not active, set a timer to submit prices after 10 seconds
      // unless a prices_updated event arrives first
      console.log("Setting timer to submit prices in 10 seconds if no prices_updated event arrives");
      submission_timer = setTimeout(() => {
        console.log("Submission timer triggered, submitting prices now");
        submission_timer = null;
        submit_prices(current_round, current_prices);
      }, 10000); // 10 seconds
    }

  });
}

// Initialize and start the price oracle
async function initialize() {
  try {
    // Load last prices from file
    read_last_prices_from_file();
    console.log('Last prices loaded from file:', last_prices);

    // retrieve chain and account info
    chainIdHash = await aergo.getChainIdHash();
    account = await aergo.getState(identity.address);

    // initialize contract event handling
    await initialize_event_handling(aergo, contract_address, on_contract_event);

    // If we still don't have a round number, query it from the contract
    if (last_round === 0) {
      try {
        const result = await aergo.queryContract(contract_address, "get_current_round", []);
        last_round = parseInt(result, 10);
        console.log("Current round from contract:", last_round);
      } catch (error) {
        console.error("Error getting current round from contract:", error);
        shutdown_node(1);
      }
    }

    // Start the price fetching and submission process
    fetch_and_submit_prices();

    if (fetch_timer == null) {
      // Set up the interval to fetch and submit prices every 5 minutes
      fetch_timer = setInterval(fetch_and_submit_prices, 5 * 60 * 1000);
    }

  } catch (error) {
    console.error("Initialization error:", error);
    process.exit(1);
  }
}

// Start the price oracle
initialize();
