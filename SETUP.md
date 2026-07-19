# Installation and Setup Guide

This guide provides step-by-step instructions to set up the environment, configure dependencies, and run the **Cognitive-State-Aware Adaptive Multi-Agent BCI System** locally on your workstation.

---

## 📋 Prerequisites

Ensure you have the following system software installed:
1. **Python (v3.11, v3.12, or v3.13)**
2. **Node.js (v18.0.0 or higher)**
3. **Ollama (for local LLM execution)**

---

## 🛠️ Step-by-Step Installation

### Step 1: Install Python & Create Virtual Environment

1. Download and install Python from the [official website](https://www.python.org/downloads/). (Check the option to **"Add Python to PATH"** during installation).
2. Open your terminal/PowerShell and navigate to the project directory:
   ```bash
   cd d:/Document/bci
   ```
3. Navigate to the `backend/` folder:
   ```bash
   cd backend
   ```
4. Create a virtual environment:
   ```bash
   python -m venv venv
   ```
5. Activate the virtual environment:
   - **Windows (PowerShell)**:
     ```powershell
     .\venv\Scripts\Activate.ps1
     ```
   - **Windows (CMD)**:
     ```cmd
     .\venv\Scripts\activate.bat
     ```
   - **Linux / macOS**:
     ```bash
     source venv/bin/activate
     ```

---

### Step 2: Install Backend Dependencies

With the virtual environment active, run:
```bash
pip install --upgrade pip
pip install -r requirements.txt
```
*Note: This will install FastAPI, LangGraph, langchain-ollama, and required server components.*

---

### Step 3: Install Machine Learning Classifier Dependencies (Optional)

If you plan to retrain the SVM classifier or run preprocessing analysis scripts:
1. Navigate to the classifier folder:
   ```bash
   cd ../workload_classifier
   ```
2. Install its specific requirements (using the same active virtual environment or a separate one):
   ```bash
   pip install -r requirements.txt
   ```
*Note: This installs MNE (for EEG analysis), Scipy, NumPy, Scikit-learn, XGBoost, and LightGBM.*

---

### Step 4: Install Frontend Dependencies

1. Navigate to the `frontend/` folder:
   ```bash
   cd ../frontend
   ```
2. Install the Node packages:
   ```bash
   npm install
   ```
*Note: This will download React, Next.js, Tailwind CSS, and typescript types.*

---

### Step 5: Setup Ollama & Pull LLM

1. Download and install Ollama from [ollama.com](https://ollama.com).
2. Start the Ollama application on your workstation.
3. Open a terminal/command prompt and pull the Qwen model:
   ```bash
   ollama pull qwen3:8b
   ```
4. Verify the model is downloaded and accessible:
   ```bash
   ollama list
   ```

---

### Step 6: Configure Environment Variables

1. Copy the template configuration file in the project root:
   ```bash
   cd ..
   cp .env.example .env
   ```
2. Edit `.env` to configure your specific parameters if they differ from the defaults (e.g., custom ports or different Ollama server URLs).

---

## 🚀 Running the System

### Option A: Running Manually (Development Mode)

You will need two terminals open:

#### Terminal 1: Backend API Server
```bash
cd backend
source venv/bin/activate  # .\venv\Scripts\Activate.ps1 on Windows
uvicorn app.main:app --reload --port 8000
```
The server will start at `http://localhost:8000`. You can inspect the interactive documentation at `http://localhost:8000/docs`.

#### Terminal 2: Frontend Dashboard
```bash
cd frontend
npm run dev
```
The Next.js developer dashboard will start at `http://localhost:3000`.

---

### Option B: Running with Docker Compose

Ensure Docker Desktop is running, then run:
```bash
docker-compose up --build
```
This automatically compiles the backend and frontend services into containerized instances and links them together.

---

## 🧪 Verification Checklist

Verify that the setup is fully operational by following these steps:

1. **Check Backend API**: Open `http://localhost:8000/health` in your browser. It should return a JSON indicating `"status": "ok"` and `"ollama_status": "ok"`.
2. **Run Pytest Suite**: Navigate to the `backend/` folder, activate the virtual env, and execute:
   ```bash
   python -m pytest tests/test_flow.py tests/test_bci_integration.py
   ```
   All test cases should pass successfully.
3. **Verify Dashboard**: Open `http://localhost:3000`, toggle to **Developer Mode**, select **HIGH** workload state, and send a message. Verify that the agent routes through 4 agents and prints short bullet points.

---

## ❌ Common Errors & Troubleshooting

### 1. Ollama Connection Error (`httpx.ConnectError`)
- **Symptoms**: Health check displays `"ollama_status": "error"`. Chat responses fail fast with code 503.
- **Fix**: Ensure the Ollama app is running in your taskbar. If you are running backend inside Docker and Ollama on host, ensure your `.env` lists `OLLAMA_HOST=http://host.docker.internal:11434`.

### 2. Missing Model Error
- **Symptoms**: Chat fails with warnings about missing `qwen3:8b` model.
- **Fix**: Run `ollama pull qwen3:8b` in your terminal. If you pulled a different model (e.g., `llama3`), update `OLLAMA_MODEL` in your `.env`.

### 3. MATLAB/NumPy File Missing Exception
- **Symptoms**: Classifier fails to load or simulator crashes because `dataset.mat` or `clean_dataset.npy` is missing.
- **Fix**: Because these files are large, they are ignored by Git. Ensure you copy the raw STEW dataset files into `workload_classifier/data/stew/` before running predictions.

### 4. PowerShell Execution Policy Blocked
- **Symptoms**: `.\venv\Scripts\Activate.ps1 cannot be loaded because running scripts is disabled on this system.`
- **Fix**: Open PowerShell as Administrator and run:
  ```powershell
  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
  ```
  Then reactivate the virtual environment.
