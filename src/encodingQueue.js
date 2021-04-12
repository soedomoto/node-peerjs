const EventEmitter = require('eventemitter3');
const FileReader = require('filereader');
const Blob = require('cross-blob');

const sLogger = require('./logger');
const logger = sLogger.logger;

class EncodingQueue extends EventEmitter {
  fileReader = new FileReader();

  _queue = [];
  _processing = false;

  constructor() {
    super();

    this.fileReader.onload = (evt) => {
      this._processing = false;

      if (evt.target) {
        this.emit('done', evt.target.result);
      }

      this.doNextTask();
    };

    this.fileReader.onerror = (evt) => {
      logger.error(`EncodingQueue error:`, evt);
      this._processing = false;
      this.destroy();
      this.emit('error', evt);
    }
  }

  get queue() {
    return this._queue;
  }

  get size() {
    return this.queue.length;
  }

  get processing() {
    return this._processing;
  }

  enque(blob) {
    this.queue.push(blob);

    if (this.processing) return;

    this.doNextTask();
  }

  destroy() {
    this.fileReader.abort();
    this._queue = [];
  }

  doNextTask() {
    if (this.size === 0) return;
    if (this.processing) return;

    this._processing = true;
    
    const blob = this.queue.shift();

    if (blob instanceof Blob) {
      try {
        blob.arrayBuffer().then(arr => {
          this.emit('done', arr);
          this.doNextTask();
        })
      } catch (e) {
        this.fileReader.readAsArrayBuffer(blob);
      }
    } 

    else if (blob instanceof ArrayBuffer) {
      this.emit('done', blob);
      this.doNextTask();
    }
    
  }
}

module.exports = EncodingQueue;