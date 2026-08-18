module.exports = {
  apps: [{
    name: "doctor-booked-backend",
    script: "src/index.js",
    cwd: "/home/opc/O-Backend/O backend",
    node_args: "--require dotenv/config",
    dotenv_path: "/home/opc/O-Backend/O backend/.env",
  }]
};
