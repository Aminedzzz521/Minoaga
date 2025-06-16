# Use a lightweight Node.js base image for efficiency
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json first to leverage Docker's build cache
# This ensures that `npm install` is re-run only if dependencies change
COPY package.json ./


# Install project dependencies
RUN npm install

# Copy the rest of the application code into the container
# This assumes your application files are in the same directory as your Dockerfile
COPY . .

# Expose the port your Node.js server listens on (8080 by default)
EXPOSE 8080

# Define the command to run your application
# Ensure your main application file is named 'app.js'
CMD ["node", "app.js"]
