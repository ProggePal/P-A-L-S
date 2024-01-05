import fs from "fs-extra";
import {
  Client,
  isFullPage,
  isFullUser,
  iteratePaginatedAPI,
} from "@notionhq/client";
import {
  EquationBlockObjectResponse,
  GetPageResponse,
  PageObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";
import { NotionToMarkdown } from "@pclouddev/notion-to-markdown";
import YAML from "yaml";
import { sh } from "./sh";
import { DatabaseMount, loadConfig, PageMount } from "./config";
import { getPageTitle, getCoverLink, getFileName } from "./helpers";
import katex from "katex";
import { MdBlock } from "@pclouddev/notion-to-markdown/build/types";
import path from "path";
import { getContentFile } from "./file";
import { getAllImageLinksFromPage, } from "./vercel_blob";
import { downloadImage } from "./images-helpers/download";
import { getImageFilename, getImageFullName } from "./images-helpers/notionImage";
import { initLogger } from "./images-helpers/logger";
import { list, put } from "@vercel/blob";
require("katex/contrib/mhchem"); // modify katex module

function getExpiryTime(blocks: MdBlock[], expiry_time: string | undefined = undefined): string | undefined {
  for (const block of blocks) {
    if (block.expiry_time !== undefined) {
      if (expiry_time === undefined) expiry_time = block.expiry_time
      else expiry_time = expiry_time < block.expiry_time ? expiry_time : block.expiry_time
    }
    if (block.children.length > 0) {
      const child_expiry_time = getExpiryTime(block.children, expiry_time)
      if (child_expiry_time) {
        if (expiry_time === undefined) expiry_time = child_expiry_time
        else expiry_time = expiry_time < child_expiry_time ? expiry_time : child_expiry_time
      }
    }
  }
  return expiry_time
}

export async function renderPage(page: PageObjectResponse, notion: Client) {

  // load formatter config
  const formatterConfig = (await loadConfig()).formatter;
  formatterConfig.equation.style

  const n2m = new NotionToMarkdown({ notionClient: notion });
  let frontInjectString = ''

  switch (formatterConfig.equation.style) {
    case 'markdown':
      n2m.setCustomTransformer("equation", async (block) => {
        const { equation } = block as EquationBlockObjectResponse;
        return `\\[${equation}\\]`;
      });
      break;
    case 'shortcode':
      n2m.setCustomTransformer("equation", async (block) => {
        const { equation } = block as EquationBlockObjectResponse;
        return `{{< math >}}\\[${equation}\\]{{< /math >}}`
      })
      break;
    case 'html':
      n2m.setCustomTransformer("equation", async (block) => {
        const { equation } = block as EquationBlockObjectResponse;
        const html = katex.renderToString(equation.expression, {
          throwOnError: false,
          displayMode: true,
        });
        return html;
      });
      frontInjectString += `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.2/dist/katex.min.css" integrity="sha384-bYdxxUwYipFNohQlHt0bjN/LCpueqWz13HufFEV1SUatKs1cm4L6fFgCi1jT643X" crossorigin="anonymous">\n`
      break
    default:
      console.warn('[Warn] invalid notion.toml config')
      break;
  }

  let nearest_expiry_time: string | null = null
  const mdblocks = await n2m.pageToMarkdown(page.id);
  const page_expiry_time = getExpiryTime(mdblocks)
  if (page_expiry_time) nearest_expiry_time = page_expiry_time
  const mdString = n2m.toMarkdownString(mdblocks);
  page.properties.Name;
  const title = getPageTitle(page);
  const frontMatter: Record<
    string,
    string | string[] | number | boolean | PageObjectResponse
  > = {
    title,
    date: page.created_time,
    lastmod: page.last_edited_time,
    draft: false,
  };

  // set featuredImage
  const featuredImageLink = await getCoverLink(page.id, notion);
  if (featuredImageLink) {
    const { link, expiry_time } = featuredImageLink;
    frontMatter.featuredImage = link;
    // update nearest_expiry_time
    if (expiry_time) {
      if (nearest_expiry_time) {
        nearest_expiry_time = expiry_time < nearest_expiry_time ? expiry_time : nearest_expiry_time
      } else {
        nearest_expiry_time = expiry_time
      }
    }
  }

  // map page properties to front matter
  for (const property in page.properties) {
    const id = page.properties[property].id;
    const response = await notion.pages.properties.retrieve({
      page_id: page.id,
      property_id: id,
    });
    if (response.object === "property_item") {
      switch (response.type) {
        case "checkbox":
          frontMatter[property] = response.checkbox;
          break;
        case "select":
          if (response.select?.name)
            frontMatter[property] = response.select?.name;
          break;
        case "multi_select":
          frontMatter[property] = response.multi_select.map(
            (select) => select.name
          );
          break;
        case "email":
          if (response.email) frontMatter[property] = response.email;
          break;
        case "url":
          if (response.url) frontMatter[property] = response.url;
          break;
        case "date":
          if (response.date?.start)
            frontMatter[property] = response.date?.start;
          break;
        case "number":
          if (response.number) frontMatter[property] = response.number;
          break;
        case "phone_number":
          if (response.phone_number)
            frontMatter[property] = response.phone_number;
          break;
        case "status":
          if (response.status?.name)
            frontMatter[property] = response.status?.name;
        // ignore these properties
        case "last_edited_by":
        case "last_edited_time":
        case "rollup":
        case "files":
        case "formula":
        case "created_by":
        case "created_time":
          break;
        default:
          break;
      }
    } else {
      for await (const result of iteratePaginatedAPI(
        // @ts-ignore
        notion.pages.properties.retrieve,
        {
          page_id: page.id,
          property_id: id,
        }
      )) {
        switch (result.type) {
          case "people":
            frontMatter[property] = frontMatter[property] || [];
            if (isFullUser(result.people)) {
              const fm = frontMatter[property];
              if (Array.isArray(fm) && result.people.name) {
                fm.push(result.people.name);
              }
            }
            break;
          case "rich_text":
            frontMatter[property] = frontMatter[property] || "";
            frontMatter[property] += result.rich_text.plain_text;
          // ignore these
          case "relation":
          case "title":
          default:
            break;
        }
      }
    }
  }

  // set default author
  if (frontMatter.authors == null) {
    const response = await notion.users.retrieve({
      user_id: page.last_edited_by.id,
    });
    if (response.name) {
      frontMatter.authors = [response.name];
    }
  }

  // save metadata
  frontMatter.NOTION_METADATA = page;

  // save update time
  frontMatter.UPDATE_TIME = (new Date()).toISOString()
  // save nearest expiry time
  if (nearest_expiry_time) frontMatter.EXPIRY_TIME = nearest_expiry_time



  return {
    title,
    pageString:
      "---\n" +
      YAML.stringify(frontMatter, {
        defaultStringType: "QUOTE_DOUBLE",
        defaultKeyType: "PLAIN",
      }) +
      "\n---\n" +
      frontInjectString + '\n' +
      mdString,
  };
}

export async function savePage(
  page: PageObjectResponse,
  notion: Client,
  mount: DatabaseMount | PageMount
) {
  const postpath = path.join(
    "content",
    mount.target_folder,
    getFileName(getPageTitle(page), page.id)
  );
  const post = getContentFile(postpath);
  if (post) {
    const metadata = post.metadata;
    // if the page is not modified, continue
    if (post.expiry_time == null && metadata.last_edited_time === page.last_edited_time) {
      console.info(`[Info] The post ${postpath} is up-to-date, skipped.`);
      return;
    }
  }
  // otherwise update the page
  console.info(`[Info] Updating ${postpath}`);

  const { title, pageString } = await renderPage(page, notion);
  const fileName = getFileName(title, page.id);

  const NewPageString = await uploadImagesToVercelSwapLinks(title.replaceAll(' ', '-'), pageString)

  await sh(
    `hugo new "${mount.target_folder}/${fileName}"`,
    false
  );
  fs.writeFileSync(`content/${mount.target_folder}/${fileName}`, NewPageString);
}


async function uploadImagesToVercelSwapLinks(docName: string, pageString: string) {
  initLogger()

  let pageStringCopy = pageString


  const links = await getAllImageLinksFromPage(pageString);

  const staticImages = await list({ prefix: `static/${docName}/`, });

  console.log('staticImages', staticImages)

  for (const link of links) {
    const fileName = getImageFilename(link.url);

    //   // if file exists in static folder, skip
    let foundFile = staticImages.blobs.find((file) => file.pathname.split('.')[0] === `static/${docName}/${fileName.split('.')[0]}`);

    console.log(`${fileName}`)
    console.log('foundFile', foundFile)
    if (foundFile) {
      console.log(`[Info] ${fileName} already exists in static folder, skipped.`)
      pageStringCopy = pageStringCopy.replace(link.url, foundFile.url);
      continue;
    }

    const dir = `static/${docName}/${fileName}`;
    const imageDir = await downloadImage(dir, true, link.url);
    console.log('saved Image', imageDir)
    if (imageDir) {
      const fileBuffer = fs.readFileSync(imageDir);
      const newUrl = await put(
        imageDir,
        fileBuffer,
        { addRandomSuffix: false, contentType: 'image/webp', access: 'public' }
      );

      console.log(`[Info] Swapped Image Url from ${link.url} to ${newUrl.url}`)
      pageStringCopy = pageStringCopy.replace(link.url, newUrl.url)
    } else {
      console.log(`[Info] Failed to download image from ${link.url}`)

    }

  }

  return pageStringCopy
}