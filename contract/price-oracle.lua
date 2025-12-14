--[[

this contract is used by other contracts to get the price of AERGO in USD and KRW

it uses external authorized nodes to fetch the price from exchanges and push it to
this contract, either:
- at regular intervals (each 1 hour)
- or when the price changes above a certain threshold (1%, configured at the nodes)
no shorter than 1 hour, no longer than 12 hours

use median of the 3 prices, to discard outliers

out of N nodes, only 3 should interact with the contract
the same 3 nodes that did it last time should do it again
if some nodes are not participating (after a timeout) the other nodes can participate (use random wait time)


protocol:

each update happens in a round
the contract keeps the number of the current round
when a node perceives a price change, it sends a txn to the contract containing the round number and the price
the contract stores the price for 2 nodes in the current round
when the 3rd node sends the price, the contract processes the given prices and stores the result
then increments the round number and clear the 2 stored prices


the price is stored in the contract state

it uses fee delegation to pay for the transactions, so the nodes do not need to have any AERGO in their account

]]

state.var {
  contract_owner = state.value(),
  authorized_nodes = state.map(),       -- address -> bool
  total_authorized_nodes = state.value(), -- track total number of authorized nodes

  current_round = state.value(),        -- current round number
  round_info = state.array(2),          -- array of {node=address, prices={currency -> price}}

  current_prices = state.map(),         -- currency (e.g., "USD") -> latest price
  tracked_currencies = state.map(),     -- currency -> bool (whether this currency is tracked)

  service_fee_stable = state.value(),   -- fee amount in stable currency (string)
  service_fee_aergo = state.value(),    -- fee amount for price queries in AERGO (bignum)
}

is_internal_call = false

--------------------------------------------------------------------------------
-- PRIVATE FUNCTIONS
--------------------------------------------------------------------------------

local function check_type(value, expected_type, name)
  if (value and expected_type == 'address') then    -- a string containing an address
    assert(type(value) == 'string', name .. " must be a string containing an address")
    -- check address length
    assert(#value == 52, string.format("invalid address length for %s (%s): %s", name, #value, value))
    -- check address checksum
    local success = pcall(system.isContract, value)
    assert(success, string.format("invalid address for %s: %s", name, value))
  elseif (value and expected_type == 'ubig') then   -- an unsigned big integer
    assert(bignum.isbignum(value), string.format("invalid type for %s: expected bignum but got %s", name, type(value)))
    assert(value >= bignum.number(0), string.format("%s must be positive number, but got %s", name, bignum.tostring(value)))
  elseif (value and expected_type == 'uint') then   -- an unsigned lua integer
    assert(type(value) == 'number', string.format("invalid type for %s: expected number but got %s", name, type(value)))
    assert(math.floor(value) == value, string.format("%s must be an integer, but got %s", name, value))
    assert(value >= 0, string.format("%s must be 0 or positive. got %s", name, value))
  else
    -- check default lua types
    assert(type(value) == expected_type, string.format("invalid type for %s, expected %s but got %s", name, expected_type, type(value)))
  end
end

local function only_contract_owner()
  assert(system.getSender() == contract_owner:get(), "permission denied")
end

local function check_authorized_node()
  local sender = system.getSender()
  assert(authorized_nodes[sender] == true, "not an authorized node")
  return sender
end

-- Get the absolute value of a bignum
local function bignum_abs(num)
  if bignum.isnegative(num) then
    return bignum.neg(num)
  end
  return num
end

local function calculate_median(values)
  -- Sort the values
  table.sort(values)
  -- Return the middle value (for 3 values)
  return values[2]
end

-- Update service fee if price changed significantly
local function update_service_fee_if_needed()
  -- get the current stable fee
  local current_fee_stable = service_fee_stable:get()

  -- Get current fee in AERGO
  local current_fee_aergo = service_fee_aergo:get() or bignum.number(0)

  -- Calculate what the fee should be with the new price
  -- Use the existing get_price_in_aergo function to convert USD to AERGO
  is_internal_call = true
  local new_fee_aergo = get_price_in_aergo(current_fee_stable)
  is_internal_call = false

  -- Calculate percentage difference
  if current_fee_aergo > bignum.number(0) then
    local fee_diff = bignum_abs(new_fee_aergo - current_fee_aergo)
    local fee_change_percent = (fee_diff * bignum.number(100)) / current_fee_aergo
    -- If fee would change by 20% or more, update it
    if fee_change_percent >= bignum.number(20) then
      service_fee_aergo:set(new_fee_aergo)
    end
  else
    -- First time setting the fee
    service_fee_aergo:set(new_fee_aergo)
  end
end

-- Process the round prices and update the official price
local function process_round(round, third_submission)
  -- Collect all price submissions for this round for each currency
  local all_prices = {}

  -- Add the first two submissions from round_info
  for i = 1, 2 do
    local submission = round_info[i]
    for currency, price in pairs(submission.prices) do
      if all_prices[currency] == nil then
        all_prices[currency] = {}
      end
      table.insert(all_prices[currency], price)
    end
  end

  -- Add the third submission
  for currency, price in pairs(third_submission.prices) do
    if all_prices[currency] == nil then
      all_prices[currency] = {}
    end
    table.insert(all_prices[currency], price)
  end

  -- Calculate median prices for each currency
  local updated_prices = {}
  for currency, values in pairs(all_prices) do
    if #values == 3 then  -- Only update if we have 3 values
      local median_price = calculate_median(values)
      current_prices[currency] = median_price
      updated_prices[currency] = tostring(median_price)
    end
  end

  -- Emit price update event
  contract.event("prices_updated", round, updated_prices)

  -- Clear round_info for next round
  round_info[1] = nil
  round_info[2] = nil

  -- Increment round number
  current_round:set(round + 1)

  -- Check if we need to update the service fee
  update_service_fee_if_needed()
end

--------------------------------------------------------------------------------
-- USER FUNCTIONS
--------------------------------------------------------------------------------

-- Get current aergo price for a specific currency
-- Returns a bignum with 4 decimal places
function get_aergo_price(currency)
  assert(type(currency) == 'string', "currency must be a string")
  currency = string.upper(currency)

  -- Check if we have a price for this pair
  local price = current_prices[currency]
  assert(price ~= nil, "price not available for " .. currency)

  if is_internal_call then
    return price
  end

  -- Check if fee is required and paid
  local required_fee = service_fee_aergo:get() or bignum.number(0)
  if required_fee > bignum.number(0) then
    local paid_fee = bignum.number(system.getAmount())
    assert(paid_fee >= required_fee, "insufficient fee paid for price query")
  end

  return price
end

-- get price in aergo for a specific currency
function get_price_in_aergo(price_string)
  assert(type(price_string) == 'string', "price must be a string in format '1.23 USD' or '104 KRW'")

  -- split the price string into amount and currency
  local amount, currency = string.match(price_string, "([%d%.]+)%s+([%a]+)")
  assert(amount and currency, "invalid price format, expected '1.23 USD' or similar")

  -- handle decimal points in string
  local integer_part, decimal_part = string.match(amount, "(%d+)%.?(%d*)")
  assert(integer_part, "invalid amount format")

  if decimal_part and decimal_part ~= "" then
    -- check decimal places limit
    assert(#decimal_part <= 4, "too many decimal places (max 4)")
    -- pad with zeros to make it a whole number
    amount = integer_part .. decimal_part .. string.rep("0", 4 - #decimal_part)
  else
    -- no decimal part, add 4 zeros
    amount = integer_part .. "0000"
  end

  -- convert amount to bignum
  local amount_bignum = bignum.number(amount)
  assert(amount_bignum > bignum.number(0), "amount must be greater than 0")

  local aergo_price = get_aergo_price(currency)

  -- AERGO has 18 decimals, so we need to multiply by 10^18 to get the proper token amount
  local aergo_decimals = bignum.number("1000000000000000000") -- 10^18

  -- calculate aergo amount: (amount_bignum * 10^18) / aergo_price
  return (amount_bignum * aergo_decimals) / aergo_price
end

--------------------------------------------------------------------------------
-- OFF-CHAIN WORKER FUNCTIONS
--------------------------------------------------------------------------------

-- Check if a node has already submitted for the current round
function check_submission(round, node_address)
  check_type(round, 'number', "round")
  check_type(node_address, 'address', "node_address")
  assert(authorized_nodes[node_address] == true, "not an authorized node")

  local current = current_round:get()

  -- If the requested round is older than current, it's over
  if round < current then
    return "new round"
  -- If the requested round is newer than current, it's invalid
  elseif round > current then
    return "invalid round"
  end

  -- Check if the node has already submitted for this round
  if (round_info[1] and round_info[1].node == node_address) or
     (round_info[2] and round_info[2].node == node_address) then
    return "submitted"
  end

  -- Node can submit for this round
  return "OK"
end

-- Submit price data for the current round
function submit_price(round, prices)
  local node_address = check_authorized_node()
  local current = current_round:get()
  local round_closed = false

  -- Verify round number
  assert(round == current, "invalid round number")

  -- Check prices table
  assert(type(prices) == 'table', "prices must be a table")

  -- Validate all prices in the submission
  for currency, price in pairs(prices) do
    assert(type(currency) == 'string', "currency must be a string")
    assert(tracked_currencies[currency] == true, "currency not tracked: " .. currency)
    -- Convert price to bignum if it's a string
    if type(price) == 'string' then
      price = bignum.number(price)
      prices[currency] = price
    end
    check_type(price, 'ubig', "price")
    assert(price > bignum.number(0), "price must be greater than 0")
  end

  -- Create submission data
  local submission = {node = node_address, prices = prices}

  -- Try to fill position 1
  if not round_info[1] then
    round_info[1] = submission
  -- Position 1 is filled, check if same sender
  elseif round_info[1].node == node_address then
    assert(false, "already submitted for this round")
  -- Try to fill position 2
  elseif not round_info[2] then
    round_info[2] = submission
  -- Position 2 is filled, check if same sender
  elseif round_info[2].node == node_address then
    assert(false, "already submitted for this round")
  -- Both positions are filled, process the round with this third submission
  else
    process_round(round, submission)
    round_closed = true
  end

  --if not round_closed then
    -- Emit event for the submission
    --contract.event("price_submitted", node_address, round, prices)
    --contract.event("price_submitted", round)
  --end
end

function get_current_round()
  return current_round:get()
end

--------------------------------------------------------------------------------
-- AUTHORIZED NODES
--------------------------------------------------------------------------------

function add_authorized_node(node_address)
  only_contract_owner()
  check_type(node_address, 'address', "node_address")

  if authorized_nodes[node_address] ~= true then
    authorized_nodes[node_address] = true
    total_authorized_nodes:set((total_authorized_nodes:get() or 0) + 1)
  end
end

function remove_authorized_node(node_address)
  only_contract_owner()
  check_type(node_address, 'address', "node_address")

  if authorized_nodes[node_address] == true then
    authorized_nodes[node_address] = nil
    total_authorized_nodes:set((total_authorized_nodes:get() or 0) - 1)
  end
end

function is_authorized_node(node_address)
  return authorized_nodes[node_address] == true
end

--------------------------------------------------------------------------------
-- CONTRACT OWNER
--------------------------------------------------------------------------------

function set_contract_owner(new_owner)
  only_contract_owner()
  check_type(new_owner, 'address', "new_owner")
  contract_owner:set(new_owner)
end

function get_contract_owner()
  return contract_owner:get()
end

--------------------------------------------------------------------------------
-- CONSTRUCTOR
--------------------------------------------------------------------------------

function constructor()
  contract_owner:set(system.getCreator())
  current_round:set(1)
  total_authorized_nodes:set(0)

  -- Add default tracked currencies
  tracked_currencies["USD"] = true
  tracked_currencies["KRW"] = true

  -- Set default service fee to 0
  service_fee_aergo:set(bignum.number(0))

  -- Set default USD fee to "0.01" (1 cent)
  service_fee_stable:set("0.01 USD")
end

--------------------------------------------------------------------------------
-- CURRENCY MANAGEMENT
--------------------------------------------------------------------------------

function add_tracked_currency(currency)
  only_contract_owner()
  assert(type(currency) == 'string', "currency must be a string")
  currency = string.upper(currency)

  tracked_currencies[currency] = true
  contract.event("currency_added", currency)
end

function remove_tracked_currency(currency)
  only_contract_owner()
  assert(type(currency) == 'string', "currency must be a string")
  currency = string.upper(currency)

  tracked_currencies[currency] = nil
  current_prices[currency] = nil
  contract.event("currency_removed", currency)
end

function is_tracked_currency(currency)
  assert(type(currency) == 'string', "currency must be a string")
  currency = string.upper(currency)
  return tracked_currencies[currency] == true
end

--------------------------------------------------------------------------------
-- FEE MANAGEMENT
--------------------------------------------------------------------------------

function set_service_fee(stable_fee)
  only_contract_owner()
  assert(type(stable_fee) == 'string', "fee must be a string")

  -- validate the stable fee format
  local amount, currency = string.match(stable_fee, "([%d%.]+)%s+([%a]+)")
  assert(amount and currency and is_tracked_currency(currency),
         "invalid stable fee format, expected '0.10 USD' or similar")

  -- set the stable fee
  service_fee_stable:set(stable_fee)

  -- if we have AERGO price on this currency, update the AERGO fee immediately
  if current_prices[currency] then
    is_internal_call = true
    local fee_in_aergo = get_price_in_aergo(stable_fee)
    is_internal_call = false
    service_fee_aergo:set(fee_in_aergo)
  end
end

function get_service_fee() -- in USD
  return service_fee_stable:get() or "0.00 USD"
end

function get_current_service_fee() -- in AERGO
  return service_fee_aergo:get() or bignum.number(0)
end

function default()
  -- to receive transfer of aergo tokens
end

function withdraw_fees(amount, recipient)
  only_contract_owner()
  -- if the amount is not specified, withdraw all the current balance
  if amount == nil or amount == "" then
    amount = contract.balance()
  end
  -- if the recipient is not specified, withdraw to the contract owner
  if recipient == nil or recipient == "" then
    recipient = contract_owner:get()
  end
  -- send the amount to the recipient
  contract.send(recipient, amount)
end

--------------------------------------------------------------------------------
-- ABI REGISTRATION
--------------------------------------------------------------------------------

abi.payable(get_aergo_price, get_price_in_aergo, default)
abi.register(submit_price, add_authorized_node, remove_authorized_node, set_contract_owner,
             add_tracked_currency, remove_tracked_currency, set_service_fee, withdraw_fees)
abi.register_view(get_contract_owner, is_authorized_node, get_current_round, check_submission,
                  is_tracked_currency, get_service_fee, get_current_service_fee)

function check_delegation()
  return is_authorized_node(system.getSender())
end

abi.fee_delegation(submit_price)
