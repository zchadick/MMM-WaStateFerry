
import sys
import json
import pymysql

def main():
    try:
        # Read the JSON payload sent from Node.js stdin
        raw_input_data = sys.stdin.read()
        if not raw_input_data.strip():
            sys.stderr.write("Error: Empty payload received from Node.js\n")
            print("Unknown")
            return

        data = json.loads(raw_input_data)

        # Extract the credentials sent dynamically from Node.js
        db_user = data.get("dbUser")
        db_pass = data.get("dbPass")
        db_host = data.get("dbHost")

        sys.stderr.write(f"DEBUG - Host: {db_host}, User: {db_user}, Pass length: {len(db_pass) if db_pass else 0}\n")

    except Exception as e:
        sys.stderr.write(f"Error parsing JSON payload: {str(e)}\n")
        print("Unknown")
        return

    try:
        # Establish the connection using variables passed from node_helper.js
        connection = pymysql.connect(
            host=db_host,
            password=db_pass,
            user=db_user,
            port=3306,
            cursorclass=pymysql.cursors.DictCursor
        )

        with connection:
            with connection.cursor() as cursor:
                # Query the server version

                cursor.execute("SELECT VERSION()")
                result = cursor.fetchone()
                
                # Output the clean string back to Node.js stdout
                print(result, flush=True)

    except Exception as e:
        sys.stderr.write(f"Database connection error: {e}\n")
        print("Connection Failed")

if __name__ == "__main__":
    main()