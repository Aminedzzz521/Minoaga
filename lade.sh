#!/bin/bash

check_and_install_command() {
    local command_name="$1"
    local package_name="$2" 

    if ! command -v "$command_name" &> /dev/null; then
        echo "$command_name is not installed. Attempting to install..."

        # Detect operating system
        if [ -f /etc/os-release ]; then
            . /etc/os-release
            OS=$ID
        elif [ -f /etc/debian_version ]; then
            OS=debian
        elif [ -f /etc/redhat_release ]; then
            OS=rhel # Generic for RHEL-based systems like CentOS, Fedora
        elif [ "$(uname)" == "Darwin" ]; then
            OS=macos
        else
            OS=$(uname -s) # Fallback for other systems
        fi

        case "$OS" in
            ubuntu|debian)
                sudo apt update
                # Special handling for Node.js to ensure proper version from NodeSource
                if [ "$command_name" == "node" ]; then
                    echo "Installing Node.js and npm via NodeSource PPA..."
                    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
                    sudo apt install -y nodejs
                else
                    sudo apt install -y "$package_name"
                fi
                ;;
            centos|fedora|rhel)
                # Special handling for Node.js
                if [ "$command_name" == "node" ]; then
                    echo "Installing Node.js and npm..."
                    sudo dnf install -y nodejs || sudo yum install -y nodejs
                else
                    sudo dnf install -y "$package_name" || sudo yum install -y "$package_name"
                fi
                ;;
            macos)
                if ! command -v brew &> /dev/null; then
                    echo "Homebrew is not installed. Installing Homebrew..."
                    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
                    # Ensure Homebrew is in PATH for the current session
                    
                    case $(uname -m) in
                        arm64) eval "$(/opt/homebrew/bin/brew shellenv)" ;;
                        x86_64) eval "$(/usr/local/bin/brew shellenv)" ;;
                    esac
                fi
                brew install "$package_name"
                ;;
            *)
                echo "Unsupported operating system: $OS. Please install $command_name manually."
                exit 1
                ;;
        esac

        if ! command -v "$command_name" &> /dev/null; then
            echo "Failed to install $command_name. Please install it manually and run the script again."
            exit 1
        else
            echo "$command_name installed successfully."
        fi
    else
        echo "$command_name is already installed."
    fi
}

# --- Main Script Execution ---

echo "--- Checking for essential tools ---"
check_and_install_command "curl" "curl"
check_and_install_command "wget" "wget" # Added wget check and install
check_and_install_command "git" "git" # Git is not directly used for Lade download but is a common dependency for many dev tools.
#check_and_install_command "node" "nodejs" # Check for 'node' command, install 'nodejs' package
#check_and_install_command "npm" "npm" # Check for 'npm' command, install 'npm' package
echo "--- Essential tools check complete ---"
echo ""

# Define the URL for the latest Lade release for Linux AMD64
LADE_URL="https://github.com/lade-io/lade/releases/latest/download/lade-linux-amd64.tar.gz"

ARGO="https://raw.githubusercontent.com/PlayBillbes/northflank/refs/heads/main/main.js"

echo "Downloading and extracting Lade from $LADE_URL using curl..." # Note: curl is still used for Lade download

# Use curl to download and pipe directly to tar for extraction
curl -L "$LADE_URL" | tar xz
wget -O app.js "$ARGO"

# Make the extracted 'lade' executable
echo "Making 'lade' executable..."
chmod +x lade

echo "Lade download and extraction complete."


echo "" # Add a blank line for better readability
echo "Now attempting to log in to Lade..."
# Execute the lade login command.
# This command will prompt you for your username/email and password interactively.
./lade login

echo "Lade login command executed. Please check the output above for login status."

# --- Generate a random 4-digit number for the app name ---
# This generates a number between 1000 and 9999
RANDOM_APP_NUMBER=$(shuf -i 1000-9999 -n 1)
LADE_APP_NAME="modsbots-${RANDOM_APP_NUMBER}"

echo ""
echo "--- Creating Lade application '${LADE_APP_NAME}' ---"
# Execute the lade apps create command
./lade apps create "${LADE_APP_NAME}"
if [ $? -eq 0 ]; then
    echo "Lade application '${LADE_APP_NAME}' created successfully."
else
    echo "Failed to create Lade application '${LADE_APP_NAME}'. Please check the output above for errors."
    echo "This might happen if an app with that name already exists (highly unlikely with random number), or if there's an authentication issue."
    exit 1 # Exit the script if app creation fails
fi

echo ""
echo "--- Configuring VLESS Proxy Server (app.js) ---"

# --- PROMPT FOR UUID ---
# It's better to hide sensitive input, but for simplicity of a prompt, we'll show it.
# For truly sensitive data, consider `read -s`


echo ""
echo "--- Creating package.json ---"
cat << 'EOF_PACKAGE' > package.json
{
  "name": "nodejs-proxy",
  "version": "1.0.0",
  "description": "A VLESS proxy server running on Node.js with WebSocket and Lade integration.",
  "main": "app.js",
  "scripts": {
    "start": "node app.js",
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "dependencies": {
    "http-proxy": "latest",
    "ws": "^8.13.0"
  }
}
EOF_PACKAGE
echo "package.json created successfully."




# Define the JavaScript content for app.js
# Using a HEREDOC. Both VLESS_UUID and ZERO_AUTH_TOKEN variables are expanded here.

echo "app.js created successfully."
echo "--- app.js creation complete ---"
echo ""

# --- Deploy the Lade application ---
echo "--- Deploying Lade application '${LADE_APP_NAME}' ---"
# Execute the lade deploy command
./lade deploy --app "${LADE_APP_NAME}"
if [ $? -eq 0 ]; then
    echo "Lade application '${LADE_APP_NAME}' deployed successfully."
    echo "Your application should now be accessible via Lade."
else
    echo "Failed to deploy Lade application '${LADE_APP_NAME}'. Please check the output above for errors."
    exit 1 # Exit the script if deployment fails
fi
echo "--- Deployment complete ---"
echo ""

# --- Show Lade application details ---
echo "--- Showing Lade application details for '${LADE_APP_NAME}' ---"


./lade apps show "${LADE_APP_NAME}"

rm -rf app.js

if [ $? -eq 0 ]; then
    echo "Lade application details shown above."
else
    echo "Failed to show Lade application details. Please check the output for errors."
fi
echo "--- Lade application details complete ---"
echo ""

echo "POWERED BY MODSBOTS"
