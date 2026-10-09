import sys
import json

def main():
    try:
        # Read the JSON payload sent from Node.js stdin
        raw_input_data = sys.stdin.read()
        if not raw_input_data.strip():
            print(0)
            return

        data = json.loads(raw_input_data)

        # Extract the variables
        sailings = data.get("sailings", [])
        db_user = data.get("dbUser", "")
        db_pass = data.get("dbPass", "")

        # Convert everything into a raw string representation and sum the character lengths
        # json.dumps ensures complex structures like the sailings array are fully stringified
        total_chars = len(str(sailings)) + len(str(db_user)) + len(str(db_pass))

        # Output the integer result back to stdout
        print(total_chars)

    except Exception as e:
        # Fallback or error logging to stderr, returning 0 on failure
        sys.stderr.write(f"Error in predictive_model_update.py: {str(e)}\n")
        print(0)

if __name__ == "__main__":
    main()