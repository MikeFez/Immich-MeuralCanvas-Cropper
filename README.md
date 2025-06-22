# Immich-MeuralCanvas-Cropper

A comprehensive web application designed to seamlessly crop images from Immich for optimal display on Meural Canvas digital frames. This tool provides an intuitive interface for creating perfectly sized portrait (1080×1920) and landscape (1920×1080) crops that maintain aspect ratios and image quality.

## 📋 Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Storage & Data Persistence](#storage--data-persistence)
- [API Endpoints](#api-endpoints)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

## ✨ Features

### Core Functionality
- **Interactive Crop Editor**: Visual crop rectangle with drag-and-resize handles
- **Dual Orientation Support**: Create both portrait (1080×1920) and landscape (1920×1080) crops
- **Aspect Ratio Preservation**: Automatic maintenance of correct aspect ratios
- **Real-time Preview**: Live preview of crop areas with overlay visualization
- **Saved Crop Data**: Persistent storage of crop coordinates for each image

### Immich Integration
- **Direct Album Access**: Connect to specific Immich albums for input and output
- **Metadata Preservation**: Maintains EXIF data and image quality
- **Batch Processing**: Process multiple images efficiently
- **Asset ID Mapping**: Seamless integration with Immich's asset management

### Meural Canvas Integration
- **Live Preview**: Send crops directly to Meural Canvas for preview
- **Multi-Device Support**: Configure multiple Meural Canvas devices
- **Automatic Upload**: Batch upload completed crops to Meural Canvas

### User Interface
- **Responsive Design**: Works on desktop, tablet, and mobile devices
- **Landing Page**: Welcome screen when no image is selected
- **Progress Tracking**: Visual indicators for processing status
- **Error Handling**: Comprehensive error messages and recovery

## 🔧 Prerequisites

- **Python 3.11+**
- **Immich Server**: Running instance with API access
- **Meural Canvas**: One or more Meural Canvas devices (optional)
- **Network Access**: Connectivity to Immich server and Meural devices

## 🚀 Installation

### Docker (Recommended)

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd Immich-MeuralCanvas-Cropper
   ```

2. **Create configuration**:
   ```bash
   cp config-example.yaml config/config.yaml
   ```

3. **Edit configuration** (see [Configuration](#configuration) section)

4. **Build and run**:

   #### Option A: Using Makefile (Recommended)
   ```bash
   # Production mode
   make run

   # Development mode (with live code reloading)
   make dev

   # View logs
   make logs

   # Stop container
   make stop

   # Clean up
   make clean
   ```

   #### Option B: Using Docker directly
   ```bash
   # Build the image
   docker build -t meural-cropper .

   # Run in production mode
   docker run -d -p 5001:5000 \
     -v $(pwd)/config:/config \
     --name meural-cropper \
     meural-cropper

   # Run in development mode
   docker run -it -p 5001:5000 \
     -v $(pwd)/config:/config \
     -v $(pwd)/app:/app \
     --name meural-cropper \
     meural-cropper
   ```   #### Option C: Using Docker Compose
   Create a `docker-compose.yml` file:
   ```yaml
   version: '3.8'

   services:
     meural-cropper:
       build: .
       container_name: meural-cropper
       ports:
         - "5001:5000"
       volumes:
         - ./config:/config
       restart: unless-stopped
       healthcheck:
         test: ["CMD", "curl", "-f", "http://localhost:5000/health"]
         interval: 30s
         timeout: 10s
         retries: 3

     # For development with live reload
     meural-cropper-dev:
       build: .
       container_name: meural-cropper-dev
       ports:
         - "5001:5000"
       volumes:
         - ./config:/config
         - ./app:/app
       environment:
         - FLASK_ENV=development
         - FLASK_DEBUG=1
       profiles:
         - dev
   ```

   Then run:
   ```bash
   # Production
   docker-compose up -d

   # Development
   docker-compose --profile dev up -d

   # View logs
   docker-compose logs -f

   # Stop
   docker-compose down
   ```

### Quick Start Example

Here's a complete example from clone to running:

```bash
# Clone the repository
git clone https://github.com/your-repo/Immich-MeuralCanvas-Cropper.git
cd Immich-MeuralCanvas-Cropper

# Create and edit configuration
cp config-example.yaml config/config.yaml
# Edit config/config.yaml with your Immich details

# Start the application (choose one method)

# Method 1: Using Makefile (easiest)
make run

# Method 2: Using Docker Compose
docker-compose up -d

# Method 3: Using Docker directly
docker build -t meural-cropper .
docker run -d -p 5001:5000 -v $(pwd)/config:/config --name meural-cropper meural-cropper

# Access the application
open http://localhost:5001
```

### Docker Volume Persistence

For production deployments, ensure data persistence with proper volume mounting:

```bash
# Create persistent directories
mkdir -p ./data/config

# Run with persistent storage
docker run -d -p 5001:5000 \
  -v ./data/config:/config \
  --name meural-cropper \
  meural-cropper
```

The application will be available at `http://localhost:5001`

### Manual Installation

1. **Clone and setup**:
   ```bash
   git clone <repository-url>
   cd Immich-MeuralCanvas-Cropper
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

2. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

3. **Configure application**:
   ```bash
   cp config-example.yaml config/config.yaml
   # Edit config/config.yaml with your settings
   ```

4. **Run application**:
   ```bash
   cd app
   python app.py
   ```

The application will be available at `http://localhost:8085`

## ⚙️ Configuration

Create `config/config.yaml` based on the example:

```yaml
# Image dimensions for Meural Canvas
dimensions:
  portrait_size: [1080, 1920]   # Width x Height
  landscape_size: [1920, 1080]  # Width x Height

# Immich server configuration
immich:
  url: "http://your-immich-server:2283"
  api_key: "your-immich-api-key"
  input_album_id: "album-id-for-source-images"
  output_album_id: "album-id-for-cropped-images"

# Meural Canvas devices (optional)
meural:
  devices:
    - name: "Living Room Canvas"
      ip: "192.168.1.136"
      preview_duration: 10  # seconds
    - name: "Bedroom Canvas"
      ip: "192.168.1.137"
      preview_duration: 15
```

### Getting Immich API Key
1. Log into your Immich web interface
2. Go to Account Settings → API Keys
3. Create a new API key
4. Copy the key to your config file

### Finding Album IDs
1. Navigate to the album in Immich web interface
2. The album ID is in the URL: `/albums/{album-id}`
3. Or use Immich API: `GET /api/albums`

## 📖 Usage

### Basic Workflow

1. **Access the Application**
   - Open `http://localhost:5001` in your browser
   - You'll see the landing page with image selection sidebar

2. **Select an Image**
   - Browse images from the configured Immich album
   - Click on any image to start cropping
   - Previously cropped images show status indicators

3. **Create Portrait Crop**
   - Adjust the crop rectangle by dragging corners or edges
   - The aspect ratio is automatically maintained at 9:16
   - Click "Crop and Continue" to save the portrait crop

4. **Create Landscape Crop**
   - The interface switches to landscape mode (16:9 aspect ratio)
   - Adjust the crop area for the landscape orientation
   - Click "Crop and Continue" to save the landscape crop

5. **Review and Upload**
   - Preview both crops in the final review stage
   - Use "Preview on Meural" to test on your canvas devices
   - Click "Upload Crops" to save to Immich output album

### Advanced Features

#### Keyboard Shortcuts
- **Arrow Keys**: Fine-tune crop position
- **Shift + Arrow**: Resize crop rectangle
- **Enter**: Proceed to next stage
- **Escape**: Cancel current operation

#### Batch Operations
- Use the "Upload All" button to generate and upload all completed crops from metadata
- Filter view to show only unprocessed images
- Progress indicators show batch operation status
- Images are generated fresh during upload for consistent quality

#### Quality Settings
The application preserves image quality through:
- LANCZOS resampling for high-quality resizing
- EXIF data preservation
- Optimal JPEG compression settings

## 💾 Storage & Data Persistence

### Crop Data Storage
The application stores crop coordinates and metadata to ensure persistence:

**Location**: `/config/crops/metadata.json`

**Format**:
```json
{
  "crops": {
    "asset-id-123": {
      "portrait": {
        "x": 720,
        "y": 100,
        "width": 863,
        "height": 1537
      },
      "landscape": {
        "x": 0,
        "y": 120,
        "width": 2305,
        "height": 1296
      }
    }
  }
}
```

### On-Demand Image Generation
The application generates cropped images dynamically when needed:

- **Individual Crops**: Images are generated and temporarily stored when creating crops for preview
- **Batch Upload**: "Upload All" reads metadata and generates all crops on-demand during upload
- **Temporary Storage**: Generated images are stored temporarily in `/output/` during processing
- **Space Efficient**: No permanent storage of cropped images, saving disk space

### Benefits of Metadata-Based Approach
- **Storage Efficiency**: Only crop coordinates are permanently stored, not the full images
- **Always Fresh**: Images are generated from current source data during upload
- **Consistent Quality**: All images use the same processing pipeline regardless of when they were cropped
- **Backup Safety**: Crop data survives application restarts and is easy to backup
- **Version Control**: Track changes to crop coordinates without managing large image files
- **Performance**: Faster backups and smaller persistent data footprint

### Data Management
- Crop metadata is automatically saved when crops are created
- Cropped images are generated on-demand during individual cropping or batch upload
- Only configuration and crop metadata need to be persisted across container updates:
  ```bash
  docker run -v /host/path/config:/config ...
  ```

## 🔌 API Endpoints

### Image Management
- `GET /images` - List available images from Immich
- `GET /image/{identifier}` - Serve individual image
- `GET /crop-data/{identifier}/{orientation}` - Get saved crop coordinates
- `POST /crop` - Process and save crop

### Batch Operations
- `POST /upload-all` - Upload all completed crops to Immich
- `POST /reset` - Reset processing status for an image
- `GET /sync-immich` - Synchronize with Immich albums

### Meural Integration
- `POST /preview-meural` - Send image to Meural Canvas for preview
- `GET /meural-devices` - List configured Meural devices

### System
- `GET /health` - Application health check
- `GET /config` - Current configuration (sanitized)

## 🛠️ Development

### Project Structure
```
├── app/
│   ├── app.py                 # Main Flask application
│   ├── config.py             # Configuration management
│   ├── static/               # Frontend assets
│   │   ├── js/              # JavaScript modules
│   │   └── styles.css       # Application styles
│   ├── templates/           # HTML templates
│   └── utils/               # Backend utilities
│       ├── immich_handler.py    # Immich API integration
│       ├── image_processor.py   # Image processing logic
│       ├── meural_handler.py    # Meural Canvas integration
│       └── file_handler.py     # File system operations
├── config/                  # Configuration files
└── Dockerfile              # Container configuration
```

### Frontend Architecture
- **Modular JavaScript**: Separate modules for different concerns
- **State Management**: Centralized application state
- **Responsive UI**: CSS Grid and Flexbox layouts
- **Error Handling**: Comprehensive error boundaries

### Backend Architecture
- **Flask Framework**: Lightweight web framework optimized for self-hosted deployments
- **Modular Design**: Separate handlers for different integrations
- **Error Recovery**: Graceful handling of network failures
- **Logging**: Comprehensive request and error logging

### Running in Development
```bash
# Install development dependencies
pip install -r requirements.txt

# Set development environment
export FLASK_ENV=development
export FLASK_DEBUG=1

# Run with auto-reload
cd app
python app.py
```

## 🔧 Troubleshooting

### Common Issues

#### Connection to Immich Failed
- Verify Immich URL and API key in config
- Check network connectivity to Immich server
- Ensure API key has proper permissions

#### Images Not Loading
- Confirm input album ID is correct
- Check Immich album contains accessible images
- Verify image file formats are supported

#### Meural Preview Not Working
- Confirm Meural Canvas IP addresses
- Check network connectivity to Meural devices
- Verify devices are powered on and connected

#### Crop Rectangle Issues
- Refresh the page to reset crop state
- Check browser console for JavaScript errors
- Ensure images are fully loaded before cropping

### Log Analysis
Check application logs for detailed error information:
```bash
# Docker logs
docker logs <container-name>

# Manual installation
tail -f /path/to/app/logs/application.log
```

### Performance Optimization
- Use SSD storage for image processing
- Ensure adequate RAM for large images
- Consider image size limits for very large files
- Flask's threaded mode handles multiple concurrent requests efficiently
- Optimized for small-scale self-hosted deployments

## 🤝 Contributing

### Development Setup
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

### Code Style
- Follow PEP 8 for Python code
- Use ESLint for JavaScript
- Include docstrings for all functions
- Add comments for complex logic

### Testing
```bash
# Run Python tests
python -m pytest tests/

# Run JavaScript tests
npm test

# Integration tests
python tests/integration_test.py
```

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- Immich team for the excellent photo management platform
- Meural for creating beautiful digital canvas devices
- Contributors and users of this project

---

For additional support, please open an issue on the project repository or check the troubleshooting section above.
