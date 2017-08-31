// @flow
const azure = require('azure-storage');
const config = require('config');
const fs = require('fs-extra');
const gm = require('gm');
const mkdirp = require('mkdirp');
const parse = require('co-busboy');
const path = require('path');
const Promise = require('bluebird');
const request = require('request');
const logger = require('./logger');
const util = require('./util');
const LabelModel = require('./label');
const send = require('koa-send');
const _ = require('koa-route');

const blobService = azure.createBlobService(
  config.storage.STORAGE_ACCOUNT,
  config.storage.STORAGE_ACCESS_KEY,
);

async function getFilePath(param) {
  const containers = await getContainersAsync();
  logger.info(`param: ${param}`);

  const result = /(\d+)(.*)/.exec(param);
  logger.info(result);
  if (!result) {
    return null;
  }

  const containerIndex = parseInt(result[1], 10);
  const container = containers[containerIndex];
  if (!container) {
    return null;
  }

  let subdir = result[2];
  if (subdir.length > 0) {
    if (subdir[0] !== '/') {
      return null;
    }

    subdir = subdir.substr(1);
  }
  const filepath = subdir ? `${container.name}/${subdir}` : container.name;
  return filepath;
}

/**
 * @param {string} storageAccount
 * @param {string} containerName
 * @param {string} filename
 * @return {string}
 */
function generateAzureBlobURL(
  storageAccount /* :string */,
  containerName /* :string */,
  filename /* :string */,
) {
  const url = `https://${storageAccount}.blob.core.windows.net/${containerName}/${filename}`;
  return url;
}

/**
 * @param {string} storageAccount
 * @param {string} containerName
 * @param {string} filename
 */
async function getLabels(
  storageAccount /* :string */,
  containerName /* :string */,
  filename /* :string */,
) {
  const docUrl = generateAzureBlobURL(storageAccount, containerName, filename);
  const labels = await LabelModel.find({ docUrl }).exec();
  const modeledLabels = labels.map(label => ({
    start: label.start,
    end: label.end,
    label: label.label || '',
  }));

  return modeledLabels;
}

/**
 * @param {string} filepath
 * @return {Promise<array>}
 */
function deleteLabels(
  storageAccount /* :string */,
  containerName /* :string */,
  filename /* :string */,
) {
  return new Promise((resolve) => {
    const docUrl = generateAzureBlobURL(storageAccount, containerName, filename);
    const labels = LabelModel.deleteMany(
      { docUrl },
      err => (err ? console.error(err) : resolve(labels)),
    );
  });
}

/**
 * @param {string} storageAccount
 * @param {string} containerName
 * @param {string} filename
 * @param {string} data
 */
function addLabels(
  storageAccount /* :string */,
  containerName /* :string */,
  filename /* :string */,
  data /* :any */,
) {
  const docUrl = generateAzureBlobURL(storageAccount, containerName, filename);

  const newData = data.map(label => ({
    docUrl,
    start: label.start,
    end: label.end,
    label: label.label,
  }));

  let newLabels = [];
  return new Promise((resolve) => {
    LabelModel.insertMany(newData, (err, result) => {
      newLabels = result;
      resolve(newLabels);
    });
  });
}

function getImageInfo(filepath) {
  const fileparts = [];
  fileparts[0] = filepath.substring(0, filepath.indexOf('/'));
  fileparts[1] = filepath.substring(filepath.indexOf('/') + 1);
  const info = {};

  return new Promise((resolve, reject) => {
    blobService.getBlobToStream(
      fileparts[0],
      fileparts[1],
      fs.createWriteStream('output.jpeg'),
      (error) => {
        if (!error) {
          const img = gm('output.jpeg');
          img.size((err, value) => {
            if (err) {
              reject(err);
              return;
            }

            info.size = value;
            img.orientation((err2, value2) => {
              if (err2) {
                reject(err2);
                return;
              }

              info.orientation = value2;
              resolve(info);
            });
          });
        }
      },
    );
  });
}

/**
 * Returns a promise resolving to an array of pkgcloud contaienrs
 * @return {Promise<array>}
 */
async function getContainersAsync() {
  let containers = [];

  const aggregateContainers = (err, result, cb) => {
    if (err) {
      cb(err);
    } else {
      containers = containers.concat(result.entries);
      if (result.continuationToken !== null) {
        blobService.listContainersSegmented(result.continuationToken, aggregateContainers);
      } else {
        cb(null, containers);
      }
    }
  };

  return new Promise((resolve, reject) => {
    blobService.listContainersSegmented(null, (err, result) => {
      aggregateContainers(err, result, (err, containers) => {
        if (err) {
          logger.warn(err);
          reject(err);
        } else {
          // Add azure storage account to containers
          const decaratedContainers = Array.isArray(containers)
            ? containers.map(container =>
              Object.assign(container, { storageAccount: config.storage.STORAGE_ACCOUNT }),
            )
            : containers;
          resolve(decaratedContainers);
        }
      });
    });
  });
}

/**
 * Returns a promise resolving to an array of pkgcloud files
 * @param {string} container target container name
 * @return {Promise<array>}
 */
async function getBlobsAsync(container /* :string */) {
  let blobs = [];
  const aggregateBlobs = (containerName, err, result, cb) => {
    if (err) {
      cb(err);
    } else {
      blobs = blobs.concat(result.entries);
      if (result.continuationToken !== null) {
        blobService.listBlobsSegmented(containerName, result.continuationToken, aggregateBlobs);
      } else {
        cb(null, blobs);
      }
    }
  };

  return new Promise((resolve, reject) => {
    blobService.listBlobsSegmented(container, null, (err, result) => {
      aggregateBlobs(container, err, result, (err, blobs) => {
        if (err) {
          logger.warn(err);
          reject(err);
        } else {
          resolve(blobs);
        }
      });
    });
  });
}

/**
 * Downloads the file to ${projectRoot}/files
 * @param {string} storageAccount 
 * @param {string} containerName 
 * @param {string} filename 
 * @throws {Error}
 * @return {string}
 */
async function downloadFile(storageAccount, containerName, filename) {
  // Concat to local file dir
  const filepath = `files/${storageAccount}/${containerName}/${filename}`;
  const dirname = path.dirname(filepath);

  if (!fs.existsSync(dirname)) {
    mkdirp.sync(dirname);
  }

  // download file locally; then send it
  try {
    // if file exists check age
    const shouldDownload = (maxage = 3600000) => {
      try {
        const stats = fs.statSync(filepath);
        const timeCreated = stats.birthtime.getTime();
        const now = new Date().getTime();
        const age = new Date(now - timeCreated);
        return age.getTime() > maxage; // older than an hour
      } catch (err) {
        return true;
      }
    };

    // download if file doesn't exist or is too old
    if (shouldDownload()) {
      await new Promise((resolve, reject) => {
        // Prep write stream
        const writeStream = fs.createWriteStream(filepath);
        writeStream
          .on('finish', () => {
            resolve(filepath);
          })
          .on('error', (err /* : Error */) => {
            reject(err);
          });

        // download
        const urlSafeAccount = encodeURIComponent(storageAccount);
        const urlSafeContainer = encodeURIComponent(containerName);
        const urlSafeFilename = encodeURIComponent(filename);
        const downloadUrl = `https://${urlSafeAccount}.blob.core.windows.net/${urlSafeContainer}/${urlSafeFilename}`;
        request(downloadUrl).pipe(writeStream);
      });
    }

    return filepath;
  } catch (err) {
    logger.error(err);
    throw err;
  }
}

/**
 * @param {string} storageAccount 
 * @param {string} containerName 
 * @param {string} filename 
 * @param {number} start 
 * @param {number} end 
 * @throws {Error}
 * @return {object} json object
 */
async function downloadPredictions(storageAccount, containerName, filename, start, end) {
  try {
    const filepath = await downloadFile(storageAccount, containerName, filename);
    const formData = {
      t1: start,
      t2: end,
      file: fs.createReadStream(filepath),
    };
    const predicitons = await new Promise((resolve, reject) => {
      request.post({ url: 'http://localhost:80/predict', formData }, (err, httpResponse, body) => {
        if (err) reject(err);
        const result = JSON.parse(body);
        const cleanPredictions = result.result.map(prediction => ({
          start: prediction.t_s,
          end: prediction.t_e,
          label: prediction.label,
        }));
        resolve(cleanPredictions);
      });
    });
    return predicitons;
  } catch (err) {
    logger.error(err);
    throw err;
  }
}

const funcs = {
  async downloadfile(ctx) {
    const requiredParams = ['storageAccount', 'containerName', 'filename'];
    const isValidGet = () =>
      Object.keys(ctx.query).every(getParam => requiredParams.includes(getParam));

    if (isValidGet()) {
      const storageAccount = ctx.query.storageAccount;
      const containerName = ctx.query.containerName;
      const filename = ctx.query.filename;

      try {
        const filepath = await downloadFile(storageAccount, containerName, filename);
        await send(ctx, `./${filepath}`);
      } catch (error) {
        logger.error(error);
        ctx.body = { error };
      }
    } else {
      ctx.body = { error: 'Invalid GET request' };
    }
  },

  async predictions(ctx) {
    const requiredParams = ['storageAccount', 'containerName', 'filename', 'start', 'end'];
    const isValidGet = () =>
      Object.keys(ctx.query).every(getParam => requiredParams.includes(getParam));

    if (isValidGet()) {
      const storageAccount = ctx.query.storageAccount;
      const containerName = ctx.query.containerName;
      const filename = ctx.query.filename;
      const start = Math.round(Number.parseFloat(ctx.query.start));
      const end = Math.ceil(Number.parseFloat(ctx.query.end));

      try {
        const predictions = await downloadPredictions(
          storageAccount,
          containerName,
          filename,
          start,
          end,
        );
        ctx.body = predictions;
      } catch (error) {
        logger.error(error);
        ctx.body = { error };
      }
    } else {
      ctx.body = { error: 'Invalid GET request' };
    }
  },

  /**
   * @param {string} param container-index/filename
   */
  async labels(ctx) {
    // retrieve container/filename information with getFilePath
    const requiredParams = ['storageAccount', 'containerName', 'filename'];
    const getParams = ctx.query;
    const isValidGet = () => Object.keys(getParams).every(param => requiredParams.includes(param));

    if (isValidGet()) {
      const storageAccount = getParams.storageAccount;
      const containerName = getParams.containerName;
      const filename = getParams.filename;
      ctx.body = await getLabels(storageAccount, containerName, filename);
    } else {
      ctx.body = { message: 'Invalid GET request' };
    }
  },

  async saveLabels(ctx) {
    // White list valid POST params
    const isValidPost = () =>
      Object.keys(ctx.request.body).every(param =>
        ['storageAccount', 'labels', 'containerName', 'filename'].includes(param),
      );

    if (isValidPost()) {
      const storageAccount = ctx.request.body.storageAccount;
      const containerName = ctx.request.body.containerName;
      const filename = ctx.request.body.filename;
      const data = ctx.request.body.labels;
      ctx.body = await deleteLabels(storageAccount, containerName, filename);
      ctx.body = await addLabels(storageAccount, containerName, filename, data);
    } else {
      ctx.body = { message: 'Invalid POST request' };
    }
  },

  async bookmarks(ctx) {
    const bookmarks = config.get('bookmarks');
    ctx.body = JSON.stringify(bookmarks.map(b => b.name));
  },

  async containers(ctx) {
    const containers = await getContainersAsync();
    ctx.body = containers;
  },

  async dir(ctx, param) {
    const dir = await getFilePath(param);
    if (!dir) {
      ctx.body = 'invalid directory';
      ctx.status = 404;
      return;
    }
    let files = [];
    logger.info(`dir: ${dir}`);
    const containerFiles = await getBlobsAsync(dir);
    files = files.concat(containerFiles);

    const data = files.reduce((result, file) => {
      // const stats = fs.lstatSync(path.resolve(dir, file));
      if (file.name.includes('.flac') || file.name.includes('.mp3')) {
        result.push({
          name: file.name,
          isDirectory: false, // file.name.indexOf('/') > -1,
          size: file.contentLength,
          mtime: file.lastModified,
        });
      }
      return result;
    }, []);
    ctx.body = data;
  },

  async imageInfo(ctx, param) {
    const filepath = getFilePath(param);
    if (!filepath) {
      ctx.body = 'invalid location';
      return;
    }

    ctx.body = await getImageInfo(filepath);
  },

  async download(ctx, param) {
    const filepath = getFilePath(param);
    if (!filepath) {
      ctx.body = { success: false, message: 'invalid location' };
    }
  },

  async image(ctx, param) {
    const filepath = getFilePath(param);
    if (!filepath) {
      ctx.body = 'invalid location';
      return;
    }

    if (!config.cacheDir) {
      await send(ctx, filepath);
      return;
    }

    const type = ctx.query.type;
    if (type !== 'sq100' && type !== 'max800') {
      ctx.body = 'invalid type';
      return;
    }

    const cacheFilepath = util.getImageCacheFilepath(filepath, type);
    await util.createImageCache(type, filepath, cacheFilepath);

    await send(ctx, cacheFilepath);
    if (!ctx.status) {
      ctx.throw(404);
    }
  },

  * upload(ctx, param) {
    const dir = getFilePath(param);
    if (!dir) {
      this.body = 'invalid location';
      return;
    }

    const parts = parse(this);
    let part = yield parts;
    while (part) {
      const filename = path.resolve(dir, part.filename);
      const readStream = part;
      const writeStream = fs.createWriteStream(filename);
      yield new Promise((resolve, reject) => {
        readStream.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', resolve);
        readStream.pipe(writeStream);
      });

      part = yield parts;
    }

    ctx.status = 200;
  },

  async createFolder(ctx, param) {
    const dir = getFilePath(param);
    if (!dir) {
      ctx.body = 'invalid location';
      return;
    }

    const folderName = ctx.request.body.name;

    const folderFilepath = path.resolve(dir, folderName);
    await fs.mkdirAsync(folderFilepath);

    ctx.body = {};
  },

  async delete(ctx, param) {
    const dir = getFilePath(param);
    if (!dir) {
      ctx.body = 'invalid location';
      return;
    }

    const files = ctx.request.body;

    if (!config.trashDir) {
      await Promise.all(files.map(file => fs.unlink(path.resolve(dir, file)))).catch(err =>
        console.error(err),
      );
      ctx.body = {};
      return;
    }

    // await Promise.all() for parallel deletion
    await Promise.all(
      files.map((file) => {
        const sourceFilepath = path.resolve(dir, file);
        const trashFilename = `${Date.now()}_${file}`;
        const trashFilepath = path.resolve(config.trashDir, trashFilename);
        return fs.move(sourceFilepath, trashFilepath);
      }),
    ).catch((err) => {
      console.error(err);
    });

    ctx.body = {};
  },
};

function init(app) {
  app.use(async (ctx, next) => {
    const reqPath = decodeURIComponent(ctx.path);
    const result = /^\/api\/(\w+)\/?(.*)/.exec(reqPath);

    if (result) {
      const apiName = result[1];
      const param = result[2];
      if (!funcs[apiName]) {
        logger.warn(`Invalid api: ${apiName}`);
        ctx.throw(403);
      }

      try {
        await funcs[apiName](ctx, param);
      } catch (err) {
        logger.warn(`Failed to handle api: ${apiName}`, err, err.stack);
        ctx.throw(500);
      }
    }

    await next();
  });
}

module.exports = init;
