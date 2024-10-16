const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AWS = require('aws-sdk');
const { BlobServiceClient } = require('@azure/storage-blob');

// Load environment variables
require('dotenv').config();

// AWS S3 configuration
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});

// Azure Blob Storage configuration with validation
let blobServiceClient;
let containerClient;

if (process.env.AZURE_STORAGE_CONNECTION_STRING && process.env.AZURE_CONTAINER_NAME) {
    try {
        blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
        containerClient = blobServiceClient.getContainerClient(process.env.AZURE_CONTAINER_NAME);
    } catch (err) {
        console.error("Error configuring Azure Blob Service:", err.message);
    }
}

// Multer configuration for local storage
const multer = require('multer');
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'public/uploads');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage }).single('image');

// Function to upload to AWS S3
const uploadToS3 = (file) => {
    const fileContent = fs.readFileSync(file.path);
    const params = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: file.filename,
        Body: fileContent,
        ContentType: file.mimetype
    };
    return s3.upload(params).promise();
};

// Function to upload to Azure Blob Storage
const uploadToAzure = async (file) => {
    if (!containerClient) {
        throw new Error("Azure Blob Storage is not configured properly.");
    }
    const blockBlobClient = containerClient.getBlockBlobClient(file.filename);
    await blockBlobClient.uploadFile(file.path);
    return `https://${blobServiceClient.accountName}.blob.core.windows.net/${process.env.AZURE_CONTAINER_NAME}/${file.filename}`;
};

// Graceful error handling for upload image
exports.uploadImage = async (req, res) => {
    try {
        upload(req, res, async (err) => {
            if (err) {
                return res.status(400).json({ 
                    message: err instanceof multer.MulterError ? 'File Upload Error' : 'File Validation Error', 
                    error: err.message 
                });
            }

            if (!req.file) {
                return res.status(400).json({ message: 'No file uploaded' });
            }

            const filePath = `/uploads/${req.file.filename}`;
            let uploadResponse = [];

            try {
                // Upload to S3
                if (process.env.UPLOAD_DEST === 's3' || process.env.UPLOAD_DEST === 'both') {
                    const s3Response = await uploadToS3(req.file);
                    uploadResponse.push({ destination: 's3', url: s3Response.Location });
                }

                // Upload to Azure
                if (process.env.UPLOAD_DEST === 'azure' || process.env.UPLOAD_DEST === 'both') {
                    const azureBlobUrl = await uploadToAzure(req.file);
                    uploadResponse.push({ destination: 'azure', url: azureBlobUrl });
                }

                // If neither s3 nor azure, upload locally
                if (!process.env.UPLOAD_DEST || (process.env.UPLOAD_DEST !== 's3' && process.env.UPLOAD_DEST !== 'azure' && process.env.UPLOAD_DEST !== 'both')) {
                    uploadResponse.push({ destination: 'local', url: filePath });
                }

                res.status(200).json({
                    message: 'Image uploaded successfully',
                    uploads: uploadResponse
                });
            } catch (uploadError) {
                console.error('Error during upload:', uploadError.message);
                res.status(500).json({
                    message: 'Error uploading file to the cloud',
                    error: uploadError.message
                });
            }
        });
    } catch (error) {
        console.error('Unexpected server error:', error.message);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
};