
//TODO: Convert images from notion to WebP And upload to Vercel Blob

import { put, copy, BlobAccessError } from '@vercel/blob';

export const config = {
    runtime: 'edge',
};

export default async function upload(filename: string, data:Buffer) {
    // const form = await request.formData();
    // const file = form.get('file') as File;
    const blob = await put(filename, data, { access: 'public' });

    return Response.json(blob);
}

//@ts-ignore
// export async function upload(name, file) {
//     try {
//         const blob = await put(name, file, { access: 'public' });
//         return Response.json(blob);
//     } catch (error) {
//         if (error instanceof BlobAccessError) {
//             // handle a recognized error
//         } else {
//             // throw the error again if it's unknown
//             throw error;
//         }
//     }

// }

// //@ts-ignore
// export default async function copyUrlToVercel(fromUrl, toPathname) {
//     const blob = await copy(fromUrl, toPathname, { access: 'public' });

//     return Response.json(blob);
// }

// download image from s3 and create a blob
export async function getBlobFromS3(url: string) {
    const res = await fetch(url);
    const blob = await res.blob();
    return blob;
}



export async function getAllImageLinksFromPage(pageString: string) {
    // find every link in pageString that contains 'amazonaws'
    const link_regex = /\[(.*?)\]\((.*?amazonaws.*?)\)/g;
    const links = pageString.matchAll(link_regex);
    const linksArray = Array.from(links, match => ({ text: match[1], url: match[2] }));
    console.log('links', linksArray);
    return linksArray;
}

// upload image to vercel blob
export async function uploadImageToVercelBlob(imageUrl: string) {
    const res = await fetch(imageUrl);
    const blob = await res.blob();
    const formData = new FormData();
    formData.append('file', blob);
    const uploadRes = await fetch('https://vercel-blob-storage.vercel.app/api/upload', {
        method: 'POST',
        body: formData
    });
    const uploadResJson = await uploadRes.json();
    console.log('uploadResJson', uploadResJson);
    return uploadResJson.url;
}

