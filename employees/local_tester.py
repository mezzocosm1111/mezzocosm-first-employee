import os
import sys

# Instructions:
# 1. Install openai: pip install openai
# 2. Set your API key: $env:OPENAI_API_KEY="sk-..." (PowerShell) or export OPENAI_API_KEY="sk-..." (Bash)
# 3. Run: python employees/local_tester.py

try:
    from openai import OpenAI
except ImportError:
    print("Error: 'openai' library not found.")
    print("Please install it running: pip install openai")
    sys.exit(1)

def load_file(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        print(f"Error: Could not find file {path}")
        return ""

def main():
    # Configuration
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("Error: OPENAI_API_KEY environment variable not set.")
        print("Please set it before running this script.")
        return

    client = OpenAI(api_key=api_key)

    # Load Context
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    system_prompt = load_file(os.path.join(base_dir, "README.md"))
    knowledge_base = load_file(os.path.join(base_dir, "sops", "knowledge_base.md"))

    if not system_prompt or not knowledge_base:
        print("Critical files missing. Check directories.")
        return

    full_system_message = f"""
{system_prompt}

# REFERENCE MATERIAL (KNOWLEDGE BASE)
{knowledge_base}

# INSTRUCTIONS FOR THIS SESSION
You are running in 'local_tester' mode.
Act exactly as Mezzo.
"""

    messages = [
        {"role": "system", "content": full_system_message}
    ]

    print("-" * 50)
    print("MEZZO LOCAL TESTER")
    print("Type 'quit' or 'exit' to stop.")
    print("-" * 50)

    while True:
        try:
            user_input = input("\nYOU: ")
            if user_input.lower() in ["quit", "exit"]:
                break

            messages.append({"role": "user", "content": user_input})

            response = client.chat.completions.create(
                model="gpt-4o", # Or usage model of choice
                messages=messages,
                temperature=0.3, # Low temperature for deterministic behavior
            )

            reply = response.choices[0].message.content
            print(f"\nMEZZO: {reply}")

            messages.append({"role": "assistant", "content": reply})

        except KeyboardInterrupt:
            print("\nExiting...")
            break
        except Exception as e:
            print(f"\nError: {e}")
            break

if __name__ == "__main__":
    main()
