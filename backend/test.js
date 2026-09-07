const { io } = require('socket.io-client');
const socket = io('http://localhost:3000/deploy-1785760963787');

socket.on('connect', () => console.log('Connected!'));
socket.on('log', (data) => console.log('LOG:', data));
socket.on('finished', (data) => { console.log('FINISHED:', data); process.exit(0); });
socket.on('connect_error', (err) => { console.error('Error:', err.message); process.exit(1); });
setTimeout(() => process.exit(1), 5000);
