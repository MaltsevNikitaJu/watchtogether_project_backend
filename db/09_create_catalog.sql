CREATE TABLE IF NOT EXISTS catalog_videos (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    video_url TEXT NOT NULL UNIQUE,
    poster_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO catalog_videos (title, description, video_url) VALUES
  ('Elephants Dream', 'Короткометражный фильм, Blender Foundation', 'https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4'),
ON CONFLICT (video_url) DO NOTHING;
