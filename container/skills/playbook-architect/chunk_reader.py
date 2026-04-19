import os
import sys
import json
import glob
from datetime import datetime

# Configuration
CURSOR_PATH = os.environ.get("CURSOR_PATH", "/workspace/group/playbook-cursor.txt")
PROJECTS_DIR = os.environ.get("PROJECTS_DIR", "/home/node/.claude/projects/-workspace-group")
OVERLAP_EVENTS = 5
CHARACTER_BUDGET = 200000

def load_cursor():
    if os.path.exists(CURSOR_PATH):
        with open(CURSOR_PATH, 'r') as f:
            return f.read().strip()
    return ""

def save_cursor(timestamp):
    os.makedirs(os.path.dirname(CURSOR_PATH), exist_ok=True)
    with open(CURSOR_PATH, 'w') as f:
        f.write(timestamp)

def truncate_large_strings(obj, max_len=2000):
    if isinstance(obj, dict):
        return {k: truncate_large_strings(v, max_len) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [truncate_large_strings(v, max_len) for v in obj]
    elif isinstance(obj, str) and len(obj) > max_len:
        return obj[:max_len] + f"... <truncated {len(obj) - max_len} more characters>"
    else:
        return obj

def get_jsonl_events():
    files = sorted(glob.glob(os.path.join(PROJECTS_DIR, "*.jsonl")))
    events = []
    for file_path in files:
        try:
            with open(file_path, 'r') as f:
                for line in f:
                    if line.strip():
                        try:
                            event = json.loads(line)
                            if "timestamp" in event:
                                event = truncate_large_strings(event)
                                events.append(event)
                        except json.JSONDecodeError:
                            continue
        except Exception:
            continue
    # Sort all events globally by timestamp to handle multi-session chronological order
    events.sort(key=lambda x: x["timestamp"])
    return events

def is_human_message(event):
    if event.get("type") != "user":
        return False
    content = event.get("message", {}).get("content")
    if isinstance(content, str):
        return True
    if isinstance(content, list):
        # If any block is a tool_result, it is a tool response, not a human prompt
        return not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
    return False

def group_into_turns(events):
    turns = []
    current_turn = []
    for event in events:
        if is_human_message(event):
            if current_turn:
                turns.append(current_turn)
            current_turn = [event]
        else:
            current_turn.append(event)
    if current_turn:
        turns.append(current_turn)
    return turns

def run_get(budget_override=None, overlap_override=None):
    budget = budget_override if budget_override is not None else CHARACTER_BUDGET
    overlap_count = overlap_override if overlap_override is not None else OVERLAP_EVENTS
    cursor = load_cursor()
    events = get_jsonl_events()
    turns = group_into_turns(events)

    first_new_turn_idx = -1
    for i, turn in enumerate(turns):
        # Check if any event in this turn is newer than the cursor
        if any(e["timestamp"] > cursor for e in turn):
            first_new_turn_idx = i
            break

    if first_new_turn_idx == -1:
        print("NO_MORE_DATA")
        return

    # Identify overlap from the previous turn
    overlap_context = []
    if first_new_turn_idx > 0:
        prev_turn = turns[first_new_turn_idx - 1]
        overlap_context = prev_turn[-overlap_count:]

    # Build the chunk with full turns
    chunk_events = list(overlap_context)
    current_chars = len(json.dumps(chunk_events))
    last_timestamp = cursor

    for i in range(first_new_turn_idx, len(turns)):
        turn = turns[i]
        turn_str = json.dumps(turn)
        if current_chars + len(turn_str) > budget and i > first_new_turn_idx:
            # Adding this turn would exceed budget, and we already have at least one new turn
            break
        
        chunk_events.extend(turn)
        current_chars += len(turn_str)
        # Find the latest timestamp in the newly added turn
        for e in turn:
            if e["timestamp"] > last_timestamp:
                last_timestamp = e["timestamp"]

    output = {
        "events": chunk_events,
        "final_timestamp": last_timestamp
    }
    print(json.dumps(output, indent=2))
    print(f"\nCHUNK_FINAL_TIMESTAMP: {last_timestamp}")

def run_commit(timestamp):
    save_cursor(timestamp)
    print(f"Cursor updated to {timestamp}")

def main():
    if len(sys.argv) < 2:
        print("Usage: chunk_reader.py [get|commit] [args...]")
        sys.exit(1)

    mode = sys.argv[1]
    if mode == "get":
        budget = None
        overlap = None
        if len(sys.argv) > 2:
            try:
                budget = int(sys.argv[2])
            except ValueError:
                pass
        if len(sys.argv) > 3:
            try:
                overlap = int(sys.argv[3])
            except ValueError:
                pass
        run_get(budget, overlap)
    elif mode == "commit":
        if len(sys.argv) < 3:
            print("Error: commit mode requires a timestamp")
            sys.exit(1)
        run_commit(sys.argv[2])
    else:
        print(f"Unknown mode: {mode}")
        sys.exit(1)

if __name__ == "__main__":
    main()
