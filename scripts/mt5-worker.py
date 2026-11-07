import json
import sys
import time
from datetime import datetime, timezone


def fail(message):
    print(json.dumps({"ok": False, "error": message}), flush=True)
    raise SystemExit(1)


def position_dict(position, mt5):
    return {
        "ticket": int(position.ticket),
        "symbol": str(position.symbol),
        "type": "buy" if position.type == mt5.POSITION_TYPE_BUY else "sell",
        "volume": float(position.volume),
        "price_open": float(position.price_open),
        "price_current": float(position.price_current),
        "sl": float(position.sl),
        "tp": float(position.tp),
        "profit": float(position.profit),
    }


def get_history_deals(mt5, request):
    from_timestamp = int(request.get("fromTimestamp", 0))
    to_timestamp = int(time.time())
    deals = mt5.history_deals_get(
        datetime.fromtimestamp(from_timestamp, timezone.utc),
        datetime.fromtimestamp(to_timestamp, timezone.utc),
    )
    if deals is None:
        code, message = mt5.last_error()
        fail("Could not retrieve trade history: {} ({})".format(message, code))
    entries = {
        mt5.DEAL_ENTRY_IN: "in",
        mt5.DEAL_ENTRY_OUT: "out",
        mt5.DEAL_ENTRY_INOUT: "inout",
        mt5.DEAL_ENTRY_OUT_BY: "out_by",
    }
    records = []
    for deal in deals:
        if deal.type == mt5.DEAL_TYPE_BUY:
            deal_type = "buy"
        elif deal.type == mt5.DEAL_TYPE_SELL:
            deal_type = "sell"
        else:
            deal_type = "other:" + str(int(deal.type))
        records.append({
            "ticket": int(deal.ticket),
            "order": int(deal.order),
            "positionId": int(deal.position_id),
            "time": int(deal.time),
            "symbol": str(deal.symbol),
            "type": deal_type,
            "entry": entries.get(deal.entry, "other:" + str(int(deal.entry))),
            "volume": float(deal.volume),
            "price": float(deal.price),
            "profit": float(deal.profit),
            "commission": float(deal.commission),
            "swap": float(deal.swap),
            "comment": str(deal.comment),
        })
    return records


def initialize_terminal(mt5, terminal_path, login, password, server):
    options = {
        "login": login,
        "password": password,
        "server": server,
        "timeout": 15_000,
    }
    if terminal_path:
        return mt5.initialize(terminal_path, **options)
    return mt5.initialize(**options)



def run():
    try:
        import MetaTrader5 as mt5
    except ImportError:
        fail("The MetaTrader5 Python package is missing. Install the project MT5 requirements and try again.")

    try:
        request = json.load(sys.stdin)
    except (ValueError, OSError):
        fail("The MetaTrader 5 connector received invalid input.")

    operation = request.get("operation")
    login = str(request.get("login", "")).strip()
    password = request.get("password")
    server = str(request.get("server", "")).strip()
    if not login.isdigit() or not password or not server:
        fail("A numeric account, password and server are required.")

    terminal_path = request.get("terminalPath")
    initialized = initialize_terminal(mt5, terminal_path, int(login), password, server)
    if not initialized:
        code, message = mt5.last_error()
        fail("MetaTrader 5 initialization failed: {} ({})".format(message, code))

    try:
        account = mt5.account_info()
        if account is None:
            code, message = mt5.last_error()
            fail("MetaTrader 5 account information is unavailable: {} ({})".format(message, code))

        if operation == "test":
            symbol = str(request.get("symbol", "XAUUSD")).strip()
            if not symbol or len(symbol) > 24:
                fail("A valid symbol is required for the connection test.")
            if not mt5.symbol_select(symbol, True):
                fail("MetaTrader 5 does not provide the requested symbol: {}".format(symbol))
            started = time.perf_counter()
            tick = mt5.symbol_info_tick(symbol)
            latency = round((time.perf_counter() - started) * 1000, 2)
            if tick is None or tick.bid <= 0 or tick.ask <= 0:
                fail("No valid bid/ask tick is available for {}.".format(symbol))
            result = {
                "connected": True,
                "account": int(account.login),
                "server": str(account.server),
                "latencyMs": latency,
                "tick": {
                    "symbol": symbol,
                    "bid": float(tick.bid),
                    "ask": float(tick.ask),
                    "time": int(tick.time),
                },
            }
        elif operation == "positions" or operation == "journal":
            positions = mt5.positions_get()
            if positions is None:
                code, message = mt5.last_error()
                fail("Could not retrieve open positions: {} ({})".format(message, code))
            result = {"positions": [position_dict(position, mt5) for position in positions]}
            if operation == "journal":
                result["account"] = {"login": int(account.login), "server": str(account.server)}
                result["deals"] = get_history_deals(mt5, request)
        elif operation == "history":
            result = {"deals": get_history_deals(mt5, request)}
        elif operation == "order":
            symbol = str(request.get("symbol", "")).strip()
            side = request.get("side")
            volume = float(request.get("volume", 0))
            if side not in ("buy", "sell") or not 0.01 <= volume <= 100:
                fail("Order side or volume is invalid.")
            if not mt5.symbol_select(symbol, True):
                fail("MetaTrader 5 does not provide the requested symbol: {}".format(symbol))
            info = mt5.symbol_info(symbol)
            tick = mt5.symbol_info_tick(symbol)
            if info is None or tick is None:
                fail("Could not retrieve current symbol information for {}.".format(symbol))
            order_type = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
            price = tick.ask if side == "buy" else tick.bid
            request_data = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": symbol,
                "volume": volume,
                "type": order_type,
                "price": price,
                "deviation": 20,
                "magic": 20261030,
                "comment": "Symbiote market order",
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": mt5.ORDER_FILLING_IOC,
            }
            if request.get("stopLoss") is not None:
                request_data["sl"] = float(request["stopLoss"])
            if request.get("takeProfit") is not None:
                request_data["tp"] = float(request["takeProfit"])
            response = mt5.order_send(request_data)
            if response is None:
                code, message = mt5.last_error()
                fail("MetaTrader 5 rejected the order request: {} ({})".format(message, code))
            if response.retcode not in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, mt5.TRADE_RETCODE_DONE_PARTIAL):
                fail("Order was not accepted ({}): {}".format(response.retcode, response.comment))
            result = {"ticket": int(response.order or response.deal), "retcode": int(response.retcode), "comment": str(response.comment)}
        elif operation == "close":
            ticket = int(request.get("ticket", 0))
            positions = mt5.positions_get(ticket=ticket)
            if not positions:
                fail("Open position {} was not found.".format(ticket))
            position = positions[0]
            tick = mt5.symbol_info_tick(position.symbol)
            if tick is None:
                fail("Could not retrieve a closing quote for {}.".format(position.symbol))
            is_buy = position.type == mt5.POSITION_TYPE_BUY
            response = mt5.order_send({
                "action": mt5.TRADE_ACTION_DEAL,
                "position": position.ticket,
                "symbol": position.symbol,
                "volume": position.volume,
                "type": mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY,
                "price": tick.bid if is_buy else tick.ask,
                "deviation": 20,
                "magic": 20261030,
                "comment": "Symbiote close position",
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": mt5.ORDER_FILLING_IOC,
            })
            if response is None or response.retcode not in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_DONE_PARTIAL):
                fail("Position close failed: {}".format(response.comment if response else mt5.last_error()))
            result = {"ticket": ticket, "retcode": int(response.retcode), "comment": str(response.comment)}
        elif operation == "modify":
            ticket = int(request.get("ticket", 0))
            positions = mt5.positions_get(ticket=ticket)
            if not positions:
                fail("Open position {} was not found.".format(ticket))
            position = positions[0]
            response = mt5.order_send({
                "action": mt5.TRADE_ACTION_SLTP,
                "position": ticket,
                "symbol": position.symbol,
                "sl": float(request.get("stopLoss", position.sl)),
                "tp": float(request.get("takeProfit", position.tp)),
            })
            if response is None or response.retcode != mt5.TRADE_RETCODE_DONE:
                fail("Position protection update failed: {}".format(response.comment if response else mt5.last_error()))
            result = {"ticket": ticket, "retcode": int(response.retcode), "comment": str(response.comment)}
        else:
            fail("Unsupported MetaTrader 5 operation.")
        print(json.dumps({"ok": True, "result": result}), flush=True)
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    run()
