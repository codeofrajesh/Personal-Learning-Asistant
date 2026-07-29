# Personal Learning Environment (PLE)

![PLE Cover](https://via.placeholder.com/1200x600.png?text=Personal+Learning+Environment)

A highly advanced, local-first desktop application that transforms a raw folder of videos, PDFs, and notes into a structured, trackable, and beautifully designed study environment. 

Built with **Tauri v2**, **Rust**, **React**, and **SQLite**. PLE runs completely offline, loads instantly, and is designed for students with hundreds of gigabytes of learning materials.

## ✨ Features
- **Offline-First Architecture**: No cloud syncing, no subscriptions. Everything lives in a local SQLite database that easily handles 500GB+ of scanned lectures.
- **Cinematic Video Player**: Native video playback using bundled `libmpv` rendered directly behind a transparent webview for a smooth, desktop-native experience. 
- **Automated Scanning**: Just point PLE to a folder. It automatically categorizes folders into Goals → Subjects → Chapters and extracts deterministic thumbnails using a CPU-safe background FFmpeg worker.
- **Focus & Pomodoro Timer**: A globally persistent timer that floats across all routes and tracks your deep work sessions into a local activity chart.
- **Planning Hub (Timeline & Table)**: A stunning, Google-Calendar-style Timeline view with buttery smooth scrolling to schedule tasks, deadlines, and track consistency.
- **Dark Glassmorphism UI**: A gorgeous, ultra-premium dark mode interface utilizing modern CSS glassmorphism, dynamic gradients, and GSAP animations.

## 🚀 Tech Stack
- **Frontend**: React 18, Vite, TypeScript, TailwindCSS, GSAP, Zustand.
- **Backend**: Rust, Tauri v2, rusqlite, tokio.
- **Database**: Bundled SQLite with Write-Ahead Logging (WAL) for extreme performance.
- **Media Engine**: libmpv, FFmpeg, FFprobe.

## 🛠️ How to Install (For Users)
You do not need to install Node or Rust. Simply download the `.msi` or `.exe` installer from our **Releases** page and double-click to install.

## 💻 How to Run Locally (For Developers)
To run this project locally, you will need **Node.js** and **Rust** installed on your system.

1. Clone the repository:
```bash
git clone https://github.com/codeofrajesh/Personal-Learning-Asistant.git
cd Personal-Learning-Asistant
```

2. Install dependencies:
```bash
npm install
```

3. Start the development server (with Hot-Reloading):
```bash
npm run tauri dev
```

4. Build the final Windows installers (`.msi` and `.exe`):
```bash
npm run tauri build
```

## 📜 License
This project is licensed under the **GNU General Public License v3.0 (GPLv3)**. See the `LICENSE` file for details. This open-source license ensures that any modifications to this app must also remain open-source, aligning with the licenses of the bundled `libmpv` and `ffmpeg` libraries.
