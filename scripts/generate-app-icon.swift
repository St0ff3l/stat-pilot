import CoreGraphics
import Foundation
import ImageIO

let projectRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let inputURL = projectRoot.appendingPathComponent("src/assets/sz-logo.png")
let sourceOutputURL = projectRoot.appendingPathComponent("src/assets/sz-logo.png")
let publicOutputURL = projectRoot.appendingPathComponent("public/sz-logo.png")
let iconsetURL = projectRoot.appendingPathComponent("build/sz-logo.iconset")
let icnsURL = projectRoot.appendingPathComponent("src/assets/sz-logo.icns")

guard let source = CGImageSourceCreateWithURL(inputURL as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fatalError("Unable to read (inputURL.path)")
}

let fileManager = FileManager.default
try? fileManager.createDirectory(at: iconsetURL, withIntermediateDirectories: true)

func writePNG(_ image: CGImage, to url: URL) {
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        fatalError("Unable to create (url.path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        fatalError("Unable to write (url.path)")
    }
}

func roundedImage(size: Int) -> CGImage {
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: nil,
        width: size,
        height: size,
        bitsPerComponent: 8,
        bytesPerRow: size * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        fatalError("Unable to create icon context")
    }

    context.clear(CGRect(x: 0, y: 0, width: size, height: size))
    let rect = CGRect(x: 0, y: 0, width: size, height: size)
    let radius = CGFloat(size) * 0.205
    let path = CGPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), cornerWidth: radius, cornerHeight: radius, transform: nil)

    context.saveGState()
    context.addPath(path)
    context.clip()
    context.interpolationQuality = .high
    context.draw(image, in: rect)
    context.restoreGState()

    guard let result = context.makeImage() else {
        fatalError("Unable to render icon")
    }
    return result
}

writePNG(roundedImage(size: 1024), to: sourceOutputURL)
writePNG(roundedImage(size: 512), to: publicOutputURL)

let iconSizes: [(name: String, pixels: Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

for entry in iconSizes {
    writePNG(roundedImage(size: entry.pixels), to: iconsetURL.appendingPathComponent(entry.name))
}

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconsetURL.path, "-o", icnsURL.path]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else {
    fatalError("iconutil failed with exit code " + String(iconutil.terminationStatus))
}

print("Generated rounded app icons at " + sourceOutputURL.path + ", " + publicOutputURL.path + ", and " + icnsURL.path)
