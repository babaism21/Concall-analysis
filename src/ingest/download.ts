import { createHash } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PDF_DIR, USER_AGENT, ensureDataDirs } from "../config.ts";

function pdfFilename(symbol: string, callDate: string, sourceUrl: string): string {
  const hash = createHash("sha1").update(sourceUrl).digest("hex").slice(0, 10);
  return `${symbol}_${callDate}_${hash}.pdf`;
}

export async function downloadPdf(
  symbol: string,
  callDate: string,
  sourceUrl: string
): Promise<string> {
  ensureDataDirs();
  const name = pdfFilename(symbol, callDate, sourceUrl);
  const dest = join(PDF_DIR, name);
  if (existsSync(dest)) {
    console.log(`[ingest] pdf cache hit ${name}`);
    return dest;
  }

  console.log(`[ingest] download ${sourceUrl}`);
  const res = await fetch(sourceUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/pdf,*/*",
      Referer: "https://www.bseindia.com/",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`PDF download failed ${res.status} ${sourceUrl}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000 || buf.subarray(0, 4).toString() !== "%PDF") {
    // Try AnnPdfOpen fallback if AttachHis failed
    if (sourceUrl.includes("/AttachHis/")) {
      const pname = sourceUrl.split("/").pop();
      const alt = `https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=${pname}`;
      console.log(`[ingest] retry via AnnPdfOpen ${alt}`);
      return downloadPdf(symbol, callDate, alt);
    }
    throw new Error(`Not a PDF (${buf.length} bytes) from ${sourceUrl}`);
  }
  writeFileSync(dest, buf);
  console.log(`[ingest] saved ${name} (${buf.length} bytes)`);
  return dest;
}
