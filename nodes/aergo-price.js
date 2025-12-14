var aergo_price = {}
var pending_requests = {}
var price_timeouts = {}

function request_aergo_price(exchange) {
  var url
  var currency

  switch(exchange) {
  case 'binance':
    url = 'https://api.binance.com/api/v3/ticker/price?symbol=AERGOUSDT'
    currency = 'USD'
    break
  case 'mexc':
    url = 'https://www.mexc.com/open/api/v2/market/ticker?symbol=AERGO_USDT'
    currency = 'USD'
    break
  case 'upbit':
    url = 'https://api.upbit.com/v1/ticker?markets=KRW-AERGO'
    currency = 'KRW'
    break
  case 'bithumb':
    url = 'https://api.bithumb.com/public/orderbook/AERGO_KRW'
    currency = 'KRW'
    break
  case 'coinbase':
    url = 'https://api.coinbase.com/v2/prices/AERGO-USD/spot'
    currency = 'USD'
    break
  case 'gate.io':
    url = 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=AERGO_USDT'
    currency = 'USD'
    break
  case 'crypto.com':
    url = 'https://api.crypto.com/v2/public/get-ticker?instrument_name=AERGO_USD'
    currency = 'USD'
    break
  case 'gopax':
    url = 'https://api.gopax.co.kr/trading-pairs/AERGO-KRW/ticker'
    currency = 'KRW'
    break
  case 'korbit':
    url = 'https://api.korbit.co.kr/v2/tickers?symbol=aergo_krw'
    currency = 'KRW'
    break
  case 'coinone':
    url = 'https://api.coinone.co.kr/public/v2/orderbook/KRW/AERGO?size=5'
    currency = 'KRW'
    break
  case 'okx':
    url = 'https://www.okx.com/api/v5/market/ticker?instId=AERGO-USDT'
    currency = 'USD'
    break
  case 'htx':
    url = 'https://api.htx.com/market/detail/merged?symbol=aergousdt'
    currency = 'USD'
    break
  case 'lbank':
    url = 'https://api.lbkex.com/v2/ticker.do?symbol=aergo_usdt'
    currency = 'USD'
    break
  }

  http_request(url, function(res) {

    if (!res) {
      console.log('no response from', url)
      aergo_price[exchange] = null
    } else if (res.error) {
      console.log('error from', url, res.error)
      aergo_price[exchange] = null
    } else {
      switch(exchange){
      case 'binance':
        aergo_price[exchange] = res.price ? parseFloat(res.price) : null
        break
      case 'upbit':
        aergo_price[exchange] = res[0] && res[0].trade_price ? parseFloat(res[0].trade_price) : null
        break
      case 'coinbase':
        aergo_price[exchange] = res.data && res.data.amount ? parseFloat(res.data.amount) : null
        break
      case 'mexc':
        aergo_price[exchange] = res.data && res.data[0] ?
          (parseFloat(res.data[0].ask) + parseFloat(res.data[0].bid)) / 2 : null
        break
      case 'bithumb':
        aergo_price[exchange] = res.data && res.data.asks && res.data.asks[0] && res.data.bids && res.data.bids[0] ?
          (parseFloat(res.data.asks[0].price) + parseFloat(res.data.bids[0].price)) / 2 : null
        break
      case 'gate.io':
        aergo_price[exchange] = res[0] && res[0].lowest_ask && res[0].highest_bid ?
          (parseFloat(res[0].lowest_ask) + parseFloat(res[0].highest_bid)) / 2 : null
        break
      case 'crypto.com':
        aergo_price[exchange] = res.result && res.result.data && res.result.data[0] && res.result.data[0].b && res.result.data[0].k ?
          (parseFloat(res.result.data[0].b) + parseFloat(res.result.data[0].k)) / 2 : null
        break
      case 'gopax':
        aergo_price[exchange] = res.data && res.data[0] ?
          (parseFloat(res.data[0].ask) + parseFloat(res.data[0].bid)) / 2 : null
        break
      case 'korbit':
        aergo_price[exchange] = res.success && res.data && res.data[0] && res.data[0].bestBidPrice && res.data[0].bestAskPrice ?
          (parseFloat(res.data[0].bestBidPrice) + parseFloat(res.data[0].bestAskPrice)) / 2 : null
        break
      case 'coinone':
        aergo_price[exchange] = res.result === 'success' && res.bids && res.bids[0] && res.asks && res.asks[0] ?
          (parseFloat(res.bids[0].price) + parseFloat(res.asks[0].price)) / 2 : null
        break
      case 'okx':
        aergo_price[exchange] = res.data && res.data[0] && res.data[0].askPx && res.data[0].bidPx ?
          (parseFloat(res.data[0].askPx) + parseFloat(res.data[0].bidPx)) / 2 : null
        break
      case 'htx':
        aergo_price[exchange] = res.status === 'ok' && res.tick && res.tick.ask && res.tick.bid ?
          (parseFloat(res.tick.ask[0]) + parseFloat(res.tick.bid[0])) / 2 : null
        break
      case 'lbank':
        aergo_price[exchange] = res.result === 'true' && res.data && res.data[0] && res.data[0].ticker &&
          res.data[0].ticker.high && res.data[0].ticker.low ?
          (parseFloat(res.data[0].ticker.high) + parseFloat(res.data[0].ticker.low)) / 2 : null
        break
      }
    }

    console.log('aergo price on', exchange, ':', aergo_price[exchange])

    if (aergo_price[exchange] === null) {
      console.log('response from', url, res)
      console.log('')
    }

    // Remove this exchange from pending requests
    pending_requests[currency].delete(exchange)

    // Check if we can compute the price for this currency
    if (pending_requests[currency].size === 0) {
      check_and_compute_price(currency)
    }
  })
}

function http_request(url, callback){
  // Extract domain from URL to use as referer
  const urlObj = new URL(url);
  let refererDomain = urlObj.hostname;

  // Check if we need to use curl for problematic exchanges
  if (url.includes('api.upbit.com') || url.includes('api.gateio.ws')) {
    // Use node's child_process to execute curl
    const { exec } = require('child_process');

    // Build curl command with appropriate headers
    let curlCmd = `curl -s "${url}" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"`;

    if (url.includes('api.upbit.com')) {
      curlCmd += ` -H "Origin: https://upbit.com" -H "Referer: https://upbit.com/"`;
    } else if (url.includes('api.gateio.ws')) {
      curlCmd += ` -H "Origin: https://gate.io" -H "Referer: https://gate.io/"`;
    }

    exec(curlCmd, (error, stdout, stderr) => {
      if (error) {
        console.error('curl error:', error);
        callback(null);
        return;
      }

      try {
        const data = JSON.parse(stdout);
        callback(data);
      } catch (e) {
        console.error('JSON parse error:', e, 'Response:', stdout);
        callback(null);
      }
    });

    return;
  }

  // Remove 'api.' prefix if present
  if (refererDomain.startsWith('api.')) {
    refererDomain = refererDomain.substring(4);
  }

  const referer = `${urlObj.protocol}//${refererDomain}/`;

  // Add custom headers to mimic a browser request
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': referer
  };

  // Continue with fetch for other exchanges
  fetch(url, {
    method: 'GET',
    headers: headers,
    mode: 'no-cors', // Try no-cors mode for problematic APIs
    credentials: 'omit' // Don't send cookies to avoid CORS preflight
  })
    .then(response => {
      if (!response.ok) {
        console.log(`HTTP status error from ${urlObj.hostname}: ${response.status}`);
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      return response.json();
    })
    .then(data => {
      callback(data);
    })
    .catch(error => {
      console.error('http_request error', url, error.message || error);
      callback(null);
    });
}

function median(values) {
  if (values.length === 0) return null
  const sorted = Array.from(values).sort((a, b) => {
    if (a > b) return 1;
    else if (a < b) return -1;
    return 0;
  })
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    var sum = sorted[middle - 1] + sorted[middle]
    var two = (typeof sum == 'bigint') ? 2n : 2
    return sum / two
  }
  return sorted[middle]
}

// If we have all responses or the timeout has expired, compute the price for the currency
function check_and_compute_price(currency) {

  // Clear any existing timeout for this currency
  if (price_timeouts[currency]) {
    clearTimeout(price_timeouts[currency])
    price_timeouts[currency] = null
  }

  // Get the exchanges for this currency
  let exchanges = []
  if (currency === 'USD') {
    //exchanges = ['binance', 'mexc', 'coinbase', 'gate.io', 'crypto.com']
    exchanges = ['mexc', 'coinbase', 'gate.io', 'crypto.com', 'okx', 'htx', 'lbank']
  } else if (currency === 'KRW') {
    exchanges = ['upbit', 'bithumb', 'korbit', 'coinone']
  }

  // Compute the price
  compute_aergo_price(currency, exchanges)
}

function compute_aergo_price(base, list) {
  var values = list.map(exchange => aergo_price[exchange])
  values = values.filter(v => v)

  if (values.length === 0) {
    console.log(`No valid prices available for ${base}`)
    aergo_price[base] = null
  } else {
    aergo_price[base] = median(values)
    console.log(`Final AERGO price in ${base}: ${aergo_price[base]}`)
  }

  // Check if we have both prices and can call the callback
  check_callback_condition()
}

// New function to check if we can call the callback
function check_callback_condition() {
  if (aergo_price.callback && 'USD' in aergo_price && 'KRW' in aergo_price) {
    // Call the callback with the prices
    aergo_price.callback({
      USD: aergo_price.USD,
      KRW: aergo_price.KRW
    })

    // Clear the callback to prevent multiple calls
    aergo_price.callback = null
  }
}

function get_aergo_prices(callback) {
  // Reset the aergo_price object for a new round
  aergo_price = {}

  // Store the callback in the aergo_price object
  if (callback && typeof callback === 'function') {
    aergo_price.callback = callback
  }

  // Reset pending requests
  pending_requests = {
    //USD: new Set(['binance', 'mexc', 'coinbase', 'gate.io', 'crypto.com']),
    USD: new Set(['mexc', 'coinbase', 'gate.io', 'crypto.com', 'okx', 'htx', 'lbank']),
    KRW: new Set(['upbit', 'bithumb', 'korbit', 'coinone'])
  }

  // Clear any existing timeouts
  Object.keys(price_timeouts).forEach(currency => {
    if (price_timeouts[currency]) {
      clearTimeout(price_timeouts[currency])
    }
  })

  // Set timeouts to compute prices even if some exchanges don't respond
  price_timeouts = {
    USD: setTimeout(() => check_and_compute_price('USD'), 10000), // 10 seconds timeout
    KRW: setTimeout(() => check_and_compute_price('KRW'), 10000)  // 10 seconds timeout
  }

  // KRW
  request_aergo_price('upbit')
  request_aergo_price('bithumb')
  request_aergo_price('coinone')
  request_aergo_price('korbit')
  //request_aergo_price('gopax')

  // USD
  //request_aergo_price('binance')
  request_aergo_price('mexc')
  request_aergo_price('coinbase')
  request_aergo_price('gate.io')
  request_aergo_price('crypto.com')
  request_aergo_price('okx')
  request_aergo_price('htx')
  request_aergo_price('lbank')
}

// Export the get_aergo_prices function
module.exports = {
  get_aergo_prices
}
