import asyncio
import json
import random
import time
from dataclasses import dataclass, field

import websockets
from websockets.exceptions import ConnectionClosed, ConnectionClosedError

ROOM = "Nebula"
PASSWORD = "Homophily"

SERVER_URIS = [
    "ws://localhost:621",
    "ws://localhost:622",
    "ws://localhost:623",
]

NUM_USERS = 300
WARMUP_AFTER_JOIN_SECONDS = 5.0
RUN_DURATION_SECONDS = 30.0
COOLDOWN_AFTER_SEND_SECONDS = 3.0

USE_WEIGHTED_DISTRIBUTION = False

FIRST_NAMES = [
    "Ava", "Liam", "Noah", "Emma", "Mia", "Lucas", "Ethan", "Zoe", "Aria", "Leo",
    "Ivy", "Ezra", "Nova", "Milo", "Luna", "Kai", "Nina", "Jade", "Ruby", "Theo",
    "Elio", "Skye", "Juno", "Ari", "Sage", "Mina", "Cora", "Finn", "Iris", "Niko",
    "Maya", "Rowan", "Tessa", "Aiden", "Sarah", "Jonah", "Clara", "Owen", "Hazel", "Eli",
]

PARAGRAPH_SENTENCES = [
    "Scout", "Soldier", "Pyro", "Demo", "Heavy", "Engi", "Medic", "Sniper", "Spy"
]

start_event = asyncio.Event()

stats = {
    "join_success": 0,
    "join_failed": 0,
    "messages_attempted": 0,
    "messages_sent": 0,
    "disconnects": 0,
    "send_timestamps": [],
    "server_joins": {},
}


def choose_server(index: int) -> str:
    if not USE_WEIGHTED_DISTRIBUTION:
        return random.choice(SERVER_URIS)

    roll = random.random()
    if roll < 0.5:
        return SERVER_URIS[0]
    if roll < 0.8:
        return SERVER_URIS[1]
    return SERVER_URIS[2]


async def wait_for(ws, expected_type: str, timeout: float = 20.0) -> dict:
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        msg = json.loads(raw)

        if msg.get("type") == "error":
            raise RuntimeError(msg.get("message"))

        if msg.get("type") == expected_type:
            return msg


async def send_json(ws, payload: dict) -> bool:
    try:
        await ws.send(json.dumps(payload))
        return True
    except ConnectionClosed:
        return False


@dataclass
class User:
    index: int
    uri: str
    username: str = field(init=False)
    ws: websockets.WebSocketClientProtocol | None = field(default=None, init=False)
    typing_min: float = field(default=0.35, init=False)
    typing_max: float = field(default=1.4, init=False)
    pause_min: float = field(default=1.0, init=False)
    pause_max: float = field(default=6.5, init=False)
    sentences: list[str] = field(default_factory=list, init=False)
    alive: bool = field(default=True, init=False)
    received_message_ids: list[str] = field(default_factory=list, init=False)
    received_messages: list[dict] = field(default_factory=list, init=False)
    listener_task: asyncio.Task | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        self.username = self.make_username(self.index)
        self.sentences = self.make_paragraph_plan(self.index)

    @staticmethod
    def make_username(index: int) -> str:
        return f"{random.choice(FIRST_NAMES)}{index:02d}"

    @staticmethod
    def make_paragraph_plan(index: int) -> list[str]:
        sentence_count = random.randint(4, 7)
        selected = random.sample(PARAGRAPH_SENTENCES, k=sentence_count)
        return [
            f"[P{index:02d}-{i + 1}] {sentence}"
            for i, sentence in enumerate(selected)
        ]

    async def connect_and_join(self) -> None:
        try:
            self.ws = await websockets.connect(
                self.uri,
                ping_interval=None,
                close_timeout=1,
                open_timeout=15,
            )

            await wait_for(self.ws, "connection")

            ok = await send_json(self.ws, {
                "type": "set_username",
                "username": self.username
            })
            if not ok:
                self.alive = False
                stats["join_failed"] += 1
                return

            await wait_for(self.ws, "username_set")

            ok = await send_json(self.ws, {
                "type": "room_password",
                "room": ROOM,
                "password": PASSWORD
            })
            if not ok:
                self.alive = False
                stats["join_failed"] += 1
                return

            await wait_for(self.ws, "room_joined")

            self.listener_task = asyncio.create_task(self.listen())

            stats["join_success"] += 1
            stats["server_joins"][self.uri] = stats["server_joins"].get(self.uri, 0) + 1
            print(f"[JOINED] {self.username} via {self.uri}")

        except Exception as exc:
            self.alive = False
            stats["join_failed"] += 1
            print(f"[JOIN-FAILED] {self.username} via {self.uri}: {exc}")

    async def listen(self) -> None:
        if self.ws is None:
            return

        try:
            while True:
                raw = await self.ws.recv()
                msg = json.loads(raw)
                msg_type = msg.get("type")

                if msg_type == "message_received":
                    msg_id = msg.get("id")
                    if msg_id:
                        self.received_message_ids.append(msg_id)
                        self.received_messages.append(msg)

                elif msg_type == "error":
                    print(f"[SERVER-ERROR] {self.username}: {msg.get('message')}")

        except ConnectionClosed:
            return
        except Exception as exc:
            print(f"[LISTEN-FAILED] {self.username}: {exc}")

    async def run(self, started_at: float) -> None:
        await start_event.wait()

        if not self.alive or self.ws is None:
            return

        sentence_index = 0

        while True:
            if not self.alive:
                break

            elapsed = time.monotonic() - started_at
            if elapsed >= RUN_DURATION_SECONDS:
                break

            if sentence_index >= len(self.sentences):
                break

            await asyncio.sleep(random.uniform(self.pause_min, self.pause_max))

            elapsed = time.monotonic() - started_at
            if elapsed >= RUN_DURATION_SECONDS:
                break

            stats["messages_attempted"] += 1

            ok = await send_json(self.ws, {"type": "typing_start"})
            if not ok:
                self.alive = False
                stats["disconnects"] += 1
                print(f"[DISCONNECTED] {self.username} before typing_start")
                break

            await asyncio.sleep(random.uniform(self.typing_min, self.typing_max))

            content = self.sentences[sentence_index]
            sentence_index += 1

            ok = await send_json(self.ws, {
                "type": "chat_message",
                "content": content
            })
            if not ok:
                self.alive = False
                stats["disconnects"] += 1
                print(f"[DISCONNECTED] {self.username} before chat_message")
                break

            now_elapsed = time.monotonic() - started_at
            stats["messages_sent"] += 1
            stats["send_timestamps"].append(now_elapsed)

            print(f"[{now_elapsed:06.2f}s] {self.username} via {self.uri}: {content}")

            ok = await send_json(self.ws, {"type": "typing_stop"})
            if not ok:
                self.alive = False
                stats["disconnects"] += 1
                print(f"[DISCONNECTED] {self.username} before typing_stop")
                break

            await asyncio.sleep(COOLDOWN_AFTER_SEND_SECONDS)

    async def close(self) -> None:
        if self.ws is None:
            return

        try:
            if self.alive:
                await send_json(self.ws, {"type": "leave_room"})
        except Exception:
            pass

        try:
            await self.ws.close()
        except (TimeoutError, ConnectionClosedError, ConnectionClosed):
            pass
        except Exception:
            pass

        if self.listener_task:
            self.listener_task.cancel()
            try:
                await self.listener_task
            except Exception:
                pass


def print_summary(elapsed: float) -> None:
    sent = stats["messages_sent"]
    attempted = stats["messages_attempted"]
    join_success = stats["join_success"]
    join_failed = stats["join_failed"]
    disconnects = stats["disconnects"]

    print("\n===== QUICK MULTI-SERVER STATS =====")
    print(f"Joined successfully: {join_success}")
    print(f"Join failed:         {join_failed}")
    print(f"Messages attempted:  {attempted}")
    print(f"Messages sent:       {sent}")
    print(f"Disconnects:         {disconnects}")
    print(f"Run duration:        {elapsed:.2f}s")

    if elapsed > 0:
        print(f"Messages/sec:        {sent / elapsed:.2f}")

    if attempted > 0:
        success_rate = (sent / attempted) * 100
        print(f"Send success rate:   {success_rate:.1f}%")

    timestamps = stats["send_timestamps"]
    if len(timestamps) >= 2:
        gaps = [
            timestamps[i] - timestamps[i - 1]
            for i in range(1, len(timestamps))
        ]
        avg_gap = sum(gaps) / len(gaps)
        print(f"Avg gap between sends: {avg_gap:.3f}s")
        print(f"Min gap between sends: {min(gaps):.3f}s")
        print(f"Max gap between sends: {max(gaps):.3f}s")

    print("\nServer join distribution:")
    for uri, count in sorted(stats["server_joins"].items()):
        print(f"  {uri}: {count}")


def print_consistency_summary(users: list["User"]) -> None:
    joined_users = [u for u in users if u.ws is not None]

    if not joined_users:
        print("\nNo joined users to compare.")
        return

    reference_user = joined_users[0]
    reference_ids = reference_user.received_message_ids

    print("\n===== ORDERING CONSISTENCY ACROSS SERVERS =====")
    print(f"Reference client: {reference_user.username} via {reference_user.uri}")
    print(f"Reference received messages: {len(reference_ids)}")

    exact_matches = 0

    for user in joined_users:
        same_length = len(user.received_message_ids) == len(reference_ids)
        same_order = user.received_message_ids == reference_ids

        if same_order:
            exact_matches += 1
            print(
                f"[MATCH] {user.username} via {user.uri}: "
                f"exact same ordering ({len(user.received_message_ids)} msgs)"
            )
            continue

        mismatch_index = None
        limit = min(len(user.received_message_ids), len(reference_ids))

        for i in range(limit):
            if user.received_message_ids[i] != reference_ids[i]:
                mismatch_index = i
                break

        if mismatch_index is None and len(user.received_message_ids) != len(reference_ids):
            mismatch_index = limit

        print(
            f"[MISMATCH] {user.username} via {user.uri}: "
            f"received={len(user.received_message_ids)}, "
            f"same_length={same_length}, "
            f"first_mismatch_index={mismatch_index}"
        )

    print(f"\nExact ordering match: {exact_matches}/{len(joined_users)} clients")


async def main() -> None:
    users = [User(i + 1, choose_server(i + 1)) for i in range(NUM_USERS)]

    print(f"Connecting {NUM_USERS} users across: {', '.join(SERVER_URIS)}")
    await asyncio.gather(*(u.connect_and_join() for u in users))
    joined_count = sum(1 for u in users if u.alive and u.ws is not None)
    print(f"{joined_count} users joined successfully.")

    print(f"Waiting {WARMUP_AFTER_JOIN_SECONDS} seconds before chatting starts...")
    await asyncio.sleep(WARMUP_AFTER_JOIN_SECONDS)

    started_at = time.monotonic()
    start_event.set()

    await asyncio.gather(*(u.run(started_at) for u in users))

    # give time for Redis fanout + final broadcasts to arrive
    await asyncio.sleep(2.0)

    elapsed = time.monotonic() - started_at
    print(f"\nFinished chat run in {elapsed:.2f} seconds.")

    print_summary(elapsed)
    print_consistency_summary(users)

    await asyncio.gather(*(u.close() for u in users), return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(main())