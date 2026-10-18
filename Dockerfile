FROM python:3.11-slim

WORKDIR /app

# Create config directory
RUN mkdir /config

# Install Python packages
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./

# Disable Flask debug mode
ENV FLASK_DEBUG=0

# Expose port
EXPOSE 5000

# Run the application
CMD ["python", "app.py"]
