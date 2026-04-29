import asyncio
import json
import os
import random
import time
from dataclasses import dataclass, field

import websockets
from websockets.exceptions import ConnectionClosed, ConnectionClosedError

ROOM = 'global'
PASSWORD = '123'
LB_HOST = os.getenv('CHAT_HOST', 'localhost')
LB_PORT = int(os.getenv('CHAT_PORT', os.getenv('LB_PORT', '8080')))
NUM_USERS = 100
WARMUP_AFTER_JOIN_SECONDS = 5.0
RUN_DURATION_SECONDS = 60.0
COOLDOWN_AFTER_SEND_SECONDS = 3.0

LEAVE_CHANCE = 0.15

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
                return

            await wait_for(self.ws, "username_set")

            ok = await send_json(self.ws, {
                "type": "join_room",
                "room": ROOM,
                "code": str(PASSWORD)
            })
            if not ok:
                self.alive = False
                return

            await wait_for(self.ws, "room_joined")
            print(f"[JOINED] {self.username}")

        except Exception as exc:
            self.alive = False
            print(f"[JOIN-FAILED] {self.username}: {exc}")

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

            ok = await send_json(self.ws, {"type": "typing_start"})
            if not ok:
                self.alive = False
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
                print(f"[DISCONNECTED] {self.username} before chat_message")
                break

            now_elapsed = time.monotonic() - started_at
            print(f"[{now_elapsed:06.2f}s] {self.username}: {content}")

            ok = await send_json(self.ws, {"type": "typing_stop"})
            if not ok:
                self.alive = False
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


async def main() -> None:
    uri = f"ws://{LB_HOST}:{LB_PORT}"
    users = [User(i + 1, uri) for i in range(NUM_USERS)]

    print(f"Connecting {NUM_USERS} users through load balancer at {LB_HOST}:{LB_PORT}...")
    await asyncio.gather(*(u.connect_and_join() for u in users))
    joined_count = sum(1 for u in users if u.alive and u.ws is not None)
    print(f"{joined_count} users joined successfully.")

    print(f"Waiting {WARMUP_AFTER_JOIN_SECONDS} seconds before chatting starts...")
    await asyncio.sleep(WARMUP_AFTER_JOIN_SECONDS)

    started_at = time.monotonic()
    start_event.set()

    await asyncio.gather(*(u.run(started_at) for u in users))
    await asyncio.gather(*(u.close() for u in users), return_exceptions=True)

    elapsed = time.monotonic() - started_at
    print(f"Finished chat run in {elapsed:.2f} seconds.")


if __name__ == "__main__":
    asyncio.run(main())