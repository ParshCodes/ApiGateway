import { config } from './config';
import { Gateway } from './proxy';

const gateway = new Gateway(config);
gateway.start(config.port);

// Graceful shutdown: let in-flight requests finish before process exits
process.on('SIGTERM', () => {
  console.log('[gateway] SIGTERM received, shutting down');
  gateway.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[gateway] SIGINT received, shutting down');
  gateway.stop();
  process.exit(0);
});
