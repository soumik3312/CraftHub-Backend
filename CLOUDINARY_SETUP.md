# Cloudinary Setup

Craft Hub now uploads avatars, post images, project images, and project source files to Cloudinary instead of saving new uploads in `backend/uploads`.

## 1. Create a Cloudinary account

1. Go to the Cloudinary dashboard.
2. Create a product environment if you do not already have one.
3. Copy these three values from the dashboard:
   - `Cloud name`
   - `API Key`
   - `API Secret`

## 2. Add environment variables to `backend/.env`

Add these values:

```env
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
CLOUDINARY_FOLDER_PREFIX=crafthub
```

`CLOUDINARY_FOLDER_PREFIX` is optional. It groups your media in folders such as:

- `crafthub/avatars`
- `crafthub/posts`
- `crafthub/projects/images`
- `crafthub/projects/source`

## 3. Restart the backend

After updating `.env`, restart the API server so the new Cloudinary config is loaded.

## 4. Test uploads

Check these flows:

1. Register or update a profile avatar.
2. Create a post with images.
3. Create a project with images.
4. Create or update a project with a source file.

If Cloudinary is configured correctly, the database will store Cloudinary URLs and the app will load those URLs directly in feed, profile, and project screens.

## 5. Important note about old local uploads

Existing records that already point to `/uploads/...` will still work as long as the local files remain in place.
Only new uploads, replacements, and deletions will use Cloudinary automatically.

## 6. Migrate old local uploads into Cloudinary

After Cloudinary is configured, run:

```bash
npm run migrate:cloudinary
```

This uploads legacy local avatars, post images, project images, and source files to Cloudinary, updates the database records, and removes the old local files after each successful migration.
