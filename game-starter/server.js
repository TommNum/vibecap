// This is a fallback server file for Railway deployment
// It simply requires and runs the compiled application
console.log('Starting application from server.js fallback...');
try {
  require('./dist/index.js');
} catch (error) {
  console.error('Failed to start application:', error);
  process.exit(1);
} 