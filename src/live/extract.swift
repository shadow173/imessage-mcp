// Text from attachments using Apple frameworks: PDFKit for PDFs, Vision OCR for images (HEIC included).
// Usage: imessage-mcp-extract pdf|ocr <path>   Prints UTF-8 text to stdout.
import AppKit
import Foundation
import PDFKit
import Vision

let args = CommandLine.arguments
guard args.count >= 3 else { FileHandle.standardError.write(Data("usage: imessage-mcp-extract pdf|ocr <path>\n".utf8)); exit(2) }
let url = URL(fileURLWithPath: args[2])

func ocr(_ image: CGImage) -> String {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  try? VNImageRequestHandler(cgImage: image).perform([request])
  return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

switch args[1] {
case "pdf":
  guard let doc = PDFDocument(url: url) else { exit(1) }
  var text = ""
  for i in 0..<min(doc.pageCount, 300) { if let s = doc.page(at: i)?.string { text += s + "\n" } }
  if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    // Scanned PDF: OCR the first pages.
    for i in 0..<min(doc.pageCount, 10) {
      guard let page = doc.page(at: i) else { continue }
      let img = page.thumbnail(of: CGSize(width: 2000, height: 2000), for: .mediaBox)
      if let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) { text += ocr(cg) + "\n" }
    }
  }
  print(text)
case "ocr":
  guard let img = NSImage(contentsOf: url), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(1) }
  print(ocr(cg))
default:
  exit(2)
}
