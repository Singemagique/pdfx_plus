// PDFx Tesseract core: the C++ side of glue/pdfx.idl (build/ocr-core).
//
// Upstream Tesseract has no WebAssembly bindings, so this file supplies the few methods the loader
// (src/shared/ocr/engine/tess-core.ts) uses that are not plain TessBaseAPI calls:
// - SetImageFile(exif, angle): reads /input, which the loader always writes as a binary P5 PGM, with
//   Leptonica's PNM reader only (no format sniffing; this core links no other image codec), and
//   returns whether an 8-bit image is now set. tesseract.js-core 7.0.0's fork had a
//   SetImageFile(exif, angle) with EXIF/angle rotation; the loader only ever passes (1, 0), so
//   anything else is refused. The loader turns `false` into TessError('params'), so a refused image
//   is never mistaken for Recognize's out-of-memory return code.
// - Init(datapath, language, oem) with a plain int OEM (the IDL has no enum).
// - GetHOCRText(page) returns a buffer this object owns until the next call (Tesseract's own
//   result is new[]-allocated and the binder would never free it: one leaked hOCR string per page).

#include <cstdio>
#include <string>

#include <allheaders.h>
#include <tesseract/baseapi.h>
#include <tesseract/ocrclass.h>

namespace pdfx {

typedef tesseract::ETEXT_DESC ETEXT_DESC;

class TessBaseAPI : public tesseract::TessBaseAPI {
 public:
  int Init(const char *datapath, const char *language, int oem) {
    if (oem < 0 || oem >= tesseract::OEM_COUNT) return -1;
    return tesseract::TessBaseAPI::Init(datapath, language,
                                        static_cast<tesseract::OcrEngineMode>(oem));
  }

  bool SetImageFile(int exif, float angle) {
    if (exif != 1 || angle != 0.0f) return false;
    FILE *fp = fopen("/input", "rb");
    if (fp == nullptr) return false;
    Pix *pix = pixReadStreamPnm(fp);
    fclose(fp);
    if (pix == nullptr) return false;
    const bool ok = pixGetDepth(pix) == 8;
    if (ok) SetImage(pix);
    pixDestroy(&pix);
    return ok;
  }

  const char *GetHOCRText(int page_number) {
    char *text = tesseract::TessBaseAPI::GetHOCRText(page_number);
    hocr_.assign(text != nullptr ? text : "");
    delete[] text;
    return hocr_.c_str();
  }

 private:
  std::string hocr_;
};

#include "glue.cpp"

}  // namespace pdfx
