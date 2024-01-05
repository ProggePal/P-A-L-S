/* eslint-disable @typescript-eslint/no-explicit-any */
import { log, LogTypes } from "./logger";
import fs from "fs";
import Axios from "axios";
import axios, { AxiosResponse } from 'axios';
import sharp from 'sharp';
import stream from "stream";

export const downloadResizeAndUpload = async (url: string, fileName: string): Promise<void> => {
    axios.get(url)
        .then((response: AxiosResponse<any>) => {
            const { set, collector_number } = response.data;
            const sourceUrl = response.data.image_uris.border_crop;
            return axios.get(sourceUrl, { responseType: 'arraybuffer' })
        })
        .then((res: AxiosResponse<ArrayBuffer>) => {
            console.log(`converting to webp!`)
            return sharp(Buffer.from(res.data))
                .webp({})
                .toFile(`static/webp/${fileName}`)
        })
        .then(() => {
            console.log(`Image downloaded and resized!`)
        })
        .catch((err: Error) => {
            console.log(`Couldn't process: ${err}`);
        })
}
export const downloadImage = async (
    //   config: NotionHugoConfig,
    //   frontMatter: frontMatter,
    filepath: string,
    convertToWebp: boolean,
    url: string
): Promise<string | null> => {
   

    const response = await Axios({
        url,
        method: "GET",
        responseType: "stream",
    });
    

    return new Promise((resolve, reject) => {
        let transformStream;
        let publishImagePath: string;

        if (convertToWebp) {
            transformStream = sharp().webp();
            publishImagePath = filepath.replace(/\.[^/.]+$/, ".webp");
        } else {
            transformStream = new stream.PassThrough();
            publishImagePath = filepath;
        }
        if (!fs.existsSync(filepath)) {
            fs.mkdirSync(filepath, { recursive: true });
        }

        const writeStream = fs.createWriteStream(publishImagePath, {});

        // store a blob in vercel
        // const storeBlob = put(publishImagePath, transformStream)

        response.data
            .pipe(transformStream)
            // .pipe(storeBlob)
            .pipe(writeStream)
            .on("error", (err: any) => {
                log(
                    `[Error] Attempts to download image: ${publishImagePath}: ${err}`,
                    LogTypes.error
                );
                reject(null);
            })
            .once("close", async () => {
                log(
                    `[Info] Attempts to download image successfully: ${publishImagePath}`,
                    LogTypes.info
                );
                resolve(publishImagePath);
            });
    });
};