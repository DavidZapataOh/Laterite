import { Footer } from '@/components/footer';
import { Hero } from '@/components/hero';
import { Nav } from '@/components/nav';
import { Story } from '@/components/story/story';

export default function Home() {
    return (
        <>
            <Nav />
            <main id="main">
                <Hero />
                <Story />
            </main>
            <Footer />
        </>
    );
}
