const { Dropbox } = require("dropbox");
const logger = require("../config/logger");

class DropboxService {
  async uploadBuffer(buffer, pathLower, accessToken) {
    const dbx = new Dropbox({ accessToken, fetch });

    try {
      // Upload file
      const uploaded = await dbx.filesUpload({
        path: pathLower,
        contents: buffer,
        mode: { ".tag": "add" },
        autorename: true,
      });

      // Create shared link
      const url = await this.ensureSharedLink(dbx, uploaded.result.path_lower);
      return url;
    } catch (error) {
      logger.error(`Dropbox upload failed for ${pathLower}: ${error.message}`);
      throw error;
    }
  }

  async ensureSharedLink(dbx, pathLower) {
    try {
      const created = await dbx.sharingCreateSharedLinkWithSettings({
        path: pathLower,
      });
      return this.toDirect(created.result.url);
    } catch (e) {
      try {
        const existing = await dbx.sharingListSharedLinks({
          path: pathLower,
          direct_only: true,
        });
        if (existing.result.links.length) {
          return this.toDirect(existing.result.links[0].url);
        }
      } catch {}
      throw e;
    }
  }

  toDirect(url) {
    return url
      .replace("www.dropbox.com", "dl.dropboxusercontent.com")
      .replace("?dl=0", "")
      .replace("&dl=0", "");
  }
}

module.exports = new DropboxService();
