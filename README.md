# Aergo Price Oracle

A decentralized price oracle for the Aergo blockchain that provides AERGO token prices in USD and KRW

## How It Works

- **Off-chain nodes** fetch AERGO prices from multiple exchanges (Coinbase, MEXC, Gate.io, Upbit, Bithumb, etc.)
- **3 authorized nodes** submit prices per round; the contract uses the **median** to discard outliers
- Prices update on a **1% threshold change** or at regular intervals (1-12 hours)
- Uses **fee delegation** so nodes don't need AERGO in their wallets

## Structure

```
contract/       # Lua smart contract
  price-oracle.lua

nodes/          # Off-chain price fetching nodes (Node.js)
  aergo-price.js      # Exchange API integrations
  price-oracle.js     # Main oracle node
```

## Contract Functions

| Function | Description |
|----------|-------------|
| `get_aergo_price(currency)` | Get AERGO price in USD or KRW (payable) |
| `get_price_in_aergo(price_string)` | Convert "1.23 USD" to AERGO amount (payable) |
| `get_current_service_fee()` | Get the current service fee in AERGO |
| `submit_price(round, prices)` | Submit prices (authorized nodes only) |

## Usage

Example of converting a price in USD to AERGO:

```lua
  local price_in_usd = "1.23 USD"  -- or stored on contract state
  local oracle_fee = contract.call(price_oracle_address, "get_current_service_fee")
  local price_in_aergo = contract.call.value(oracle_fee)(price_oracle_address, "get_price_in_aergo", price_in_usd)
```
