# Meetwings Website

This is the landing page for meetwings.com.

## Features

- Modern, responsive design
- Download button for Windows installer
- Feature highlights
- Clean, professional layout
- Mobile-friendly

## Local Preview

To preview the website locally:

1. Open `index.html` in your web browser
2. Or use a local server:
   ```bash
   # Using Python
   python -m http.server 8000

   # Using Node.js http-server
   npx http-server
   ```

Then visit `http://localhost:8000`

## Deployment

### Option 1: GitHub Pages
1. Push to your repository
2. Go to Settings > Pages
3. Select branch and `/website` folder
4. Your site will be live at `https://yourusername.github.io/meetwings`

### Option 2: Custom Domain (meetwings.com)
You can deploy to any static hosting provider:
- **Netlify**: Drag and drop the `website` folder
- **Vercel**: Connect your GitHub repo
- **Cloudflare Pages**: Deploy from GitHub
- **GitHub Pages**: Set custom domain in settings

### Setting up meetwings.com

1. Deploy the site to your hosting provider
2. Add a CNAME record pointing to your hosting provider:
   - For GitHub Pages: `kmorgan-r.github.io`
   - For Netlify/Vercel: Follow their custom domain instructions
3. Wait for DNS propagation (up to 48 hours)

## Files Structure

```
website/
├── index.html          # Main landing page
└── README.md          # This file
```

The website references assets from:
- `../src-tauri/icons/icon.png` - App icon/logo
- `../src-tauri/target/release/bundle/nsis/Meetwings_1.0.0_x64-setup.exe` - Download file

## Hosting the Installer

For production, you should host the installer file separately:

1. Upload to GitHub Releases:
   ```bash
   gh release create v1.0.0 src-tauri/target/release/bundle/nsis/Meetwings_1.0.0_x64-setup.exe
   ```

2. Update the download link in `index.html` to point to the release URL:
   ```html
   <a href="https://github.com/kmorgan-r/meetwings/releases/download/v1.0.0/Meetwings_1.0.0_x64-setup.exe">
   ```

## Updating

When you release a new version:
1. Update the version number in `index.html`
2. Update the download link
3. Update file size if changed
